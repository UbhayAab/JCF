// Notifications and pending work belong to the real subject and this mount.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
const mounts = new WeakMap();
const KINDS = { patient_assigned: 'New patient assigned', session_request: '1:1 session requested', nutrition_request: 'Nutrition request raised', nutrition_plan_not_shared: 'Plan not shared', nutrition_plan_shared: 'Nutrition plan shared', nutrition_plan_corrected: 'Nutrition plan corrected' };
const STAGES = { assignment: 'Assignment pending', call: 'First call pending', plan: 'Plan follow-up', confirm_plan: 'Completion needs confirmation' };
export async function mountCareNotifications(mount) {
  if (!mount) return;
  const token = {}; mounts.set(mount, token);
  if (isImpersonating()) { mount.innerHTML = '<section class="card nw-notifications"><h3>For you</h3><p class="nw-muted">Exit Open as to view notifications for your signed-in account.</p></section>'; return; }
  const userId = getCurrentUser()?.id;
  if (!userId) { mount.replaceChildren(); return; }
  const current = () => mounts.get(mount) === token && mount.isConnected && getCurrentUser()?.id === userId && !isImpersonating();
  mount.innerHTML = '<section class="card nw-notifications"><div data-care-alerts></div><div class="nw-pending" data-care-pending></div></section>';
  const alerts = mount.querySelector('[data-care-alerts]'), pending = mount.querySelector('[data-care-pending]');
  let rows = [], unreadOnly = true, alertsGeneration = 0, pendingGeneration = 0;
  async function loadAlerts() {
    if (!current()) return;
    const generation = ++alertsGeneration;
    alerts.innerHTML = '<h3>For you</h3><p class="nw-muted" role="status">Loading notifications...</p>';
    try {
      const { data, error } = await getSupabase().rpc('get_my_care_notifications');
      if (!current() || generation !== alertsGeneration) return;
      if (error || !Array.isArray(data)) throw new Error('unavailable');
      rows = data; paintAlerts();
    } catch {
      if (!current() || generation !== alertsGeneration) return;
      alerts.innerHTML = '<h3>For you</h3><p class="nw-error" role="status">Could not load notifications. Please try again.</p><button type="button" class="btn btn-secondary btn-sm" data-notification-retry>Retry notifications</button>';
      alerts.querySelector('[data-notification-retry]').onclick = loadAlerts;
    }
  }
  function paintAlerts() {
    if (!current()) return;
    const unread = Math.max(0, Number(rows[0]?.unread_total) || rows.filter(row => !row.seen_at).length);
    const shown = unreadOnly ? rows.filter(row => !row.seen_at) : rows;
    alerts.innerHTML = `<div class="nw-section-head"><h3>For you <span class="badge badge-primary" aria-label="${unread} unread notifications">${unread} unread</span></h3><button type="button" class="btn btn-ghost btn-sm" data-notification-refresh>Refresh</button></div><div class="chip-row"><button type="button" class="fchip ${unreadOnly ? 'on' : ''}" data-notification-view="unread">Unread</button><button type="button" class="fchip ${unreadOnly ? '' : 'on'}" data-notification-view="all">All</button></div>
    ${shown.length ? `<ul class="nw-notification-list">${shown.map((row, index) => `<li class="nw-notification ${row.seen_at ? '' : 'is-unread'}" data-notification-index="${index}"><div class="nw-notification-copy"><a class="nw-notification-title" href="${notificationHref(row)}">${sanitize(KINDS[row.kind] || 'Care update')} - ${sanitize(row.patient_name || 'Patient')}</a><div class="nw-muted">${sanitize(row.actor_name || 'Care team')} - ${sanitize(dateLabel(row.created_at))} - ${sanitize(formatRelativeTime(row.created_at))}</div></div>${row.seen_at ? '<span class="nw-muted">Seen</span>' : '<button type="button" class="btn btn-secondary btn-sm" data-notification-seen>Mark seen</button>'}</li>`).join('')}</ul>` : `<p class="nw-muted" role="status">${unreadOnly ? 'You have no unread notifications.' : 'No care notifications yet.'}</p>`}
    ${rows.length >= 100 ? '<p class="nw-muted">Showing the latest 100 notifications, with unread items first.</p>' : ''}<p class="nw-error" role="status" data-notification-error hidden></p>`;
    alerts.querySelector('[data-notification-refresh]').onclick = refresh;
    alerts.querySelectorAll('[data-notification-view]').forEach(button => { button.onclick = () => { if (current()) { unreadOnly = button.dataset.notificationView === 'unread'; paintAlerts(); } }; });
    alerts.querySelectorAll('[data-notification-index]').forEach(item => {
      const row = shown[Number(item.dataset.notificationIndex)];
      item.querySelector('[data-notification-seen]')?.addEventListener('click', async event => {
        const button = event.currentTarget, generation = alertsGeneration;
        if (!current() || button.disabled) return;
        button.disabled = true;
        try {
          const { data, error } = await getSupabase().rpc('mark_care_notification_seen', { p_id: row.id });
          if (!current() || generation !== alertsGeneration) return;
          if (error || !data?.ok) throw new Error('unconfirmed');
          await loadAlerts();
        } catch {
          if (!current() || generation !== alertsGeneration || !button.isConnected) return;
          const error = alerts.querySelector('[data-notification-error]');
          error.textContent = 'Could not mark this notification seen. Please try again.'; error.hidden = false; button.disabled = false;
        }
      });
    });
  }
  async function loadPending() {
    if (!current()) return;
    const generation = ++pendingGeneration;
    pending.innerHTML = '<h3>Nutrition follow-ups</h3><p class="nw-muted" role="status">Loading pending work...</p>';
    try {
      const { data, error } = await getSupabase().rpc('get_my_nutrition_pending');
      if (!current() || generation !== pendingGeneration) return;
      if (error || !Array.isArray(data?.items)) throw new Error('unavailable');
      const total = Math.max(Number(data.total) || 0, data.items.length);
      pending.innerHTML = `<div class="nw-section-head"><h3>Nutrition follow-ups</h3><button type="button" class="btn btn-ghost btn-sm" data-pending-refresh>Refresh follow-ups</button></div><p class="nw-muted">${total} pending. Marking a notification seen does not complete this work.</p>${data.truncated ? '<p class="nw-muted">Showing the first 50 pending requests, with overdue work first.</p>' : ''}${data.items.length ? `<ul class="nw-notification-list">${data.items.map(row => `<li class="nw-notification"><div class="nw-notification-copy"><a class="nw-notification-title" href="#nutrition-tracker?request=${encodeURIComponent(row.request_id || '')}">${sanitize(row.patient_name || 'Patient')} - ${sanitize(STAGES[row.stage] || 'Follow-up pending')}</a><div class="nw-muted">${sanitize(row.owner_name || 'Unassigned')}${row.stage === 'confirm_plan' ? ' - Plan date recorded; order needs confirmation.' : row.due_at ? ' - Due ' + sanitize(dateLabel(row.due_at)) : ' - Timing not recorded.'}</div>${row.overdue && row.stage !== 'confirm_plan' ? '<strong class="nw-error">Overdue</strong>' : ''}</div></li>`).join('')}</ul>` : '<p class="nw-muted" role="status">No pending nutrition work.</p>'}`;
      pending.querySelector('[data-pending-refresh]').onclick = loadPending;
    } catch {
      if (!current() || generation !== pendingGeneration) return;
      pending.innerHTML = '<h3>Nutrition follow-ups</h3><p class="nw-error" role="status">Could not load pending work. Please try again.</p><button type="button" class="btn btn-secondary btn-sm" data-pending-retry>Retry follow-ups</button>';
      pending.querySelector('[data-pending-retry]').onclick = loadPending;
    }
  }
  async function refresh() { if (current()) await Promise.all([loadAlerts(), loadPending()]); }
  await refresh();
  return { refresh, isCurrent: current };
}
function notificationHref(row) {
  if (row.kind === 'nutrition_request' || row.kind?.startsWith('nutrition_plan_')) return '#nutrition-tracker?request=' + encodeURIComponent(row.request_id || '');
  if (row.kind === 'session_request') return '#sessions?session=' + encodeURIComponent(row.session_id || '');
  return '#patients/' + encodeURIComponent(row.patient_id || '');
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}
