// ============================================================
// Patient Navigator: dashboard cards shared by every dashboard.
//
// js/pages/dashboard.js (the role views) and js/pages/dashboardAdmin.js
// (managers and admins, the v11 redesign) both render these. They were
// private functions of dashboard.js; v11 moved them here so the two
// dashboards render the same card from the same query instead of two
// copies drifting apart.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { showToast } from './toast.js';
import { navigate } from '../router.js';
import { icon } from './icons.js';
import { openSessionForm, suggestNextSession } from './sessionForm.js';
import { sanitize } from '../utils/validators.js';
import { avatarColor, initials } from '../utils/avatar.js';

const RESOURCE_REPLIES_URL = 'https://uhesnagqbmuyqiuzfhcv.supabase.co/functions/v1/resource-replies';

// Thousands of minutes is not a number anyone can feel. Past two hours it
// reads as hours; the exact minutes stay available in the Data room export.
export function talkTime(mins) {
  const m = Math.round(Number(mins) || 0);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 1000 ? `${h} hrs` : `${(h / 1000).toFixed(1)}k hrs`;
}

// Next Saturday circle: visible to everyone (callers invite patients on
// their calls); loggable by the teams who run them. `side` is the v11
// narrow-column card from the redesign (title, icon row, note, full-width
// button); without it, the one-line strip the role dashboards use.
export async function loadSaturdayCard(role, { side = false } = {}) {
  const el = document.getElementById('saturday-card');
  if (!el) return;
  try {
    const next = await suggestNextSession();
    const canLog = ['admin', 'manager', 'therapist', 'nutritionist'].includes(role);
    const nice = next.date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    const kind = next.type === 'nutrition' ? 'Nutrition' : 'Well-being';
    const lastLine = next.last
      ? `Last circle: ${next.last.session_type === 'nutrition' ? 'nutrition' : 'well-being'} on ${new Date(next.last.session_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`
      : 'No circles logged yet.';
    el.innerHTML = side ? `
      <div class="card sat-card">
        <h3 class="card-title">Saturday circle</h3>
        <div class="sat-row">
          <span class="sat-ico">${icon(next.type === 'nutrition' ? 'leaf' : 'heart')}</span>
          <div style="min-width:0"><div class="sat-kind">${kind}</div><div class="due-meta">${nice}</div></div>
        </div>
        <p class="sat-note">${lastLine} Invite your patients on this week's calls.</p>
        ${canLog ? `<button class="btn btn-primary btn-block" id="sat-log-btn">${icon('plus')}Log a session</button>` : ''}
      </div>` : `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 20px">
        <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1">
          <span class="stat-ico ${next.type === 'nutrition' ? 'ok' : 'violet'}">${icon(next.type === 'nutrition' ? 'leaf' : 'heart')}</span>
          <div style="min-width:0"><div class="info-value">Next circle: <strong>${kind}</strong> · ${nice}</div>
            <div class="due-meta wraps">${lastLine} Invite your patients on this week's calls.</div></div>
        </div>
        ${canLog ? `<button class="btn btn-secondary btn-sm" id="sat-log-btn">${icon('plus')}Log a session</button>` : ''}
      </div>`;
    document.getElementById('sat-log-btn')?.addEventListener('click', () =>
      openSessionForm({ defaults: { type: next.type }, onSaved: () => loadSaturdayCard(role, { side }) }));
  } catch { el.innerHTML = ''; }
}

// Patients who replied on WhatsApp to resources this mentor sent. The POC sees
// their messages and can follow up. Reply text is sanitized (patient-typed).
// Self-hides when there are no replies. Tap a row to expand the conversation.
export async function loadResourceReplies() {
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
        <span class="avatar avatar-sm" style="background:${avatarColor(name)}">${sanitize(initials(name))}</span>
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

// Blocked patients on the dashboard (field request 19/09): managers see who
// is blocked and why without opening Team > Blocked. Nobody is handed these
// patients while blocked; this is the heads-up, the review queue stays on
// the Team page. Self-hides when nobody is blocked.
export async function loadBlockedCard() {
  const el = document.getElementById('blocked-card');
  if (!el) return;
  try {
    const { data, count, error } = await getSupabase().from('v_blacklisted_patients')
      .select('patient_id,full_name,patient_code,blacklist_reason', { count: 'exact' }).limit(5);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) { el.innerHTML = ''; return; }
    const total = count ?? rows.length;
    el.innerHTML = `
      <div class="card card-flush card-flag is-danger">
        <div class="card-head"><h3>Blocked patients</h3><span class="badge badge-danger">${total}</span></div>
        <div class="due-list">${rows.map(r => `
          <div class="due-row clickable wrap-meta" data-patient="${r.patient_id}" style="cursor:pointer">
            <span class="avatar avatar-sm" style="background:var(--av-1)">${sanitize(initials(r.full_name || '?'))}</span>
            <div class="grow" style="flex:1;min-width:0"><div class="due-name">${sanitize(r.full_name || 'Unknown')} <span class="due-meta">${sanitize(r.patient_code || '')}</span></div><div class="due-meta">${sanitize(r.blacklist_reason || 'No reason recorded')}</div></div>
            <span class="row-go" aria-hidden="true">${icon('chevronRight')}</span>
          </div>`).join('')}</div>
        <div class="card-foot"><a id="open-blocked">Review on the Team page ${icon('arrowRight')}</a></div>
      </div>`;
    el.querySelectorAll('[data-patient]').forEach(row => row.addEventListener('click', () => navigate('patients/' + row.dataset.patient)));
    document.getElementById('open-blocked')?.addEventListener('click', () => navigate('team'));
  } catch { el.innerHTML = ''; }
}

// Document reads waiting for a person (sql/143): a finished read nobody has
// reviewed, or a read that stopped part way with its pages stored. Two sat for
// 16 and 26 days in Sep 2026 because nothing told anyone. The view is
// security_invoker, so each person sees only the families they can open.
// That is still too wide for "waiting for you": a nutritionist can open the
// whole nutrition pool, and saw other mentors' uploads here. Managers see
// every read waiting; everyone else sees the uploads they made.
// Self-hides when nothing is waiting.
//
// v11: each row now ends in a days chip. Before, the text column was the row's
// LAST child, so the phone rule `.due-row > div:last-child { max-width: 96px }`
// (meant for a badge column) squeezed it to 96px and the meta wrapped one word
// per line ("Reading / stopped part / way: open ..."), a 30-line card on 390px.
export async function loadDocsWaitingCard() {
  const el = document.getElementById('docs-waiting-card');
  if (!el) return;
  try {
    const sb = getSupabase();
    let query = sb.from('v_document_batches_needing_action')
      .select('batch_id,patient_id,patient_code,action,days_waiting,page_count', { count: 'exact' })
      .order('days_waiting', { ascending: false }).limit(6);
    const me = getCurrentProfile();
    if (!isManagerOrAdmin() && me?.id) query = query.eq('uploaded_by', me.id);
    const { data, count, error } = await query;
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) { el.innerHTML = ''; return; }
    const ids = [...new Set(rows.map(r => r.patient_id))];
    const { data: people } = await sb.from('patients').select('id,full_name').in('id', ids);
    const nameOf = Object.fromEntries((people || []).map(p => [p.id, p.full_name]));
    el.innerHTML = `
      <div class="card card-flush card-flag is-warn">
        <div class="card-head"><h3>Documents waiting for you</h3><span class="badge badge-warn">${count ?? rows.length}</span></div>
        <div class="due-list">${rows.map(r => {
          const what = r.action === 'review' ? 'Read, waiting for your review' : 'Reading stopped part way';
          const how = r.action === 'review' ? 'Open the patient to review it' : 'Open Documents and press Finish reading';
          const pages = `${r.page_count || 0} ${Number(r.page_count) === 1 ? 'page' : 'pages'}`;
          return `
          <div class="due-row clickable wrap-meta" data-patient="${r.patient_id}" style="cursor:pointer" title="${how}">
            <span class="avatar avatar-sm" style="background:var(--av-6)">${sanitize(initials(nameOf[r.patient_id] || '?'))}</span>
            <div class="grow" style="flex:1;min-width:0"><div class="due-name">${sanitize(nameOf[r.patient_id] || r.patient_code || 'Unknown')} <span class="due-meta">${sanitize(r.patient_code || '')}</span></div>
            <div class="due-meta">${what} · ${pages}</div></div>
            <span class="chip chip-${Number(r.days_waiting) >= 7 ? 'danger' : 'warn'}" title="${r.days_waiting} day(s) waiting">${r.days_waiting}d</span>
          </div>`; }).join('')}</div>
      </div>`;
    el.querySelectorAll('[data-patient]').forEach(row => row.addEventListener('click', () => navigate('patients/' + row.dataset.patient)));
  } catch { el.innerHTML = ''; }
}

export async function loadIntakeSummary() {
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

// "Build today's list": give every unowned, callable lead an owner, then build
// the day. The build also ROTATES today's unstarted calls away from anyone
// marked off and from no one, which is why it doubles as "Cover all" on the
// v11 dashboard. `buttons` are disabled while it runs; `onDone` reloads
// whatever the calling page shows.
// One build at a time from this page. Two taps on different buttons (Build,
// Cover all) used to start two concurrent build_daily_assignments, which can
// queue a family twice; the second also overwrote the first's saved label.
let building = false;
export async function buildAssignments({ buttons = [], onDone = async () => {} } = {}) {
  if (building) return;
  building = true;
  const sb = getSupabase();
  const btns = buttons.filter(Boolean);
  btns.forEach(b => { b.dataset.html = b.innerHTML; b.disabled = true; b.style.pointerEvents = 'none';
    if (b.tagName === 'BUTTON') b.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span>Building…'; });
  try {
    await sb.rpc('distribute_new_patients');
    const { data, error } = await sb.rpc('build_daily_assignments');
    if (error) throw error;
    if (data?.error) { showToast('Could not build: ' + data.error, 'warning'); }
    else showToast(`Today's list ready: ${data.follow_ups} follow-ups + ${data.new_leads} new across ${data.available_callers} caregiver mentors${data.covered ? ` (${data.covered} covered)` : ''}`, 'success');
    await onDone();
  } catch (err) { showToast('Could not build assignments: ' + err.message, 'error'); }
  finally {
    building = false;
    btns.forEach(b => { b.disabled = false; b.style.pointerEvents = ''; if (b.dataset.html != null) b.innerHTML = b.dataset.html; });
  }
}
