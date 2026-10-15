// The recipient is always auth.uid() in the RPC, never an Open as profile.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';

const KINDS = { patient_assigned: 'New patient assigned', session_request: '1:1 session requested', nutrition_request: 'Nutrition request raised' };

export async function mountCareNotifications(mount) {
  if (!mount) return;
  if (isImpersonating()) {
    mount.innerHTML = '<section class="card nw-notifications"><h3>For you</h3><p class="nw-muted">Exit Open as to view notifications for your signed-in account.</p></section>';
    return;
  }
  const userId = getCurrentUser()?.id;
  if (!userId) return;
  let rows = [];
  let unreadOnly = true;
  let generation = 0;
  const current = () => mount.isConnected && getCurrentUser()?.id === userId && !isImpersonating();
  async function load() {
    const thisGeneration = ++generation;
    mount.innerHTML = '<section class="card nw-notifications"><h3>For you</h3><p class="nw-muted" role="status">Loading notifications...</p></section>';
    try {
      const { data, error } = await getSupabase().rpc('get_my_care_notifications');
      if (!current() || thisGeneration !== generation) return;
      if (error) throw error;
      rows = Array.isArray(data) ? data : [];
      paint();
    } catch (error) {
      if (!current() || thisGeneration !== generation) return;
      mount.innerHTML = `<section class="card nw-notifications"><h3>For you</h3><p class="nw-error" role="status">Could not load notifications: ${sanitize(error?.message || 'Please try again.')}</p><button type="button" class="btn btn-secondary btn-sm" data-notification-retry>Retry</button></section>`;
      mount.querySelector('[data-notification-retry]').addEventListener('click', load);
    }
  }
  function paint() {
    if (!current()) return;
    const unread = Number(rows[0]?.unread_total ?? rows.filter(row => !row.seen_at).length);
    const shown = unreadOnly ? rows.filter(row => !row.seen_at) : rows;
    mount.innerHTML = `<section class="card nw-notifications">
      <div class="nw-section-head"><h3>For you <span class="badge badge-primary" aria-label="${unread} unread notifications">${unread} unread</span></h3><button type="button" class="btn btn-ghost btn-sm" data-notification-refresh>Refresh</button></div>
      <div class="chip-row"><button type="button" class="fchip ${unreadOnly ? 'on' : ''}" data-notification-view="unread">Unread</button><button type="button" class="fchip ${!unreadOnly ? 'on' : ''}" data-notification-view="all">All</button></div>
      ${shown.length ? `<ul class="nw-notification-list">${shown.map((row, index) => `<li class="nw-notification ${row.seen_at ? '' : 'is-unread'}" data-notification-index="${index}"><div class="nw-notification-copy"><a class="nw-notification-title" href="${notificationHref(row)}">${sanitize(KINDS[row.kind] || 'Care update')} - ${sanitize(row.patient_name || 'Patient')}</a><div class="nw-muted">${sanitize(row.actor_name || 'Care team')} - <time datetime="${sanitize(row.created_at || '')}" title="${sanitize(dateLabel(row.created_at))}">${sanitize(formatRelativeTime(row.created_at))}</time></div></div>${row.seen_at ? '<span class="nw-muted">Seen</span>' : '<button type="button" class="btn btn-secondary btn-sm" data-notification-seen>Mark seen</button>'}</li>`).join('')}</ul>` : `<p class="nw-muted" role="status">${unreadOnly ? 'You have no unread notifications.' : 'No care notifications yet.'}</p>`}
      ${rows.length === 100 ? '<p class="nw-muted">Showing the latest 100 notifications, with unread items first.</p>' : ''}
      <p class="nw-error" role="status" data-notification-error hidden></p>
    </section>`;
    mount.querySelector('[data-notification-refresh]').addEventListener('click', load);
    mount.querySelectorAll('[data-notification-view]').forEach(button => button.addEventListener('click', () => {
      unreadOnly = button.dataset.notificationView === 'unread'; paint();
    }));
    mount.querySelectorAll('[data-notification-index]').forEach(item => {
      const row = shown[Number(item.dataset.notificationIndex)];
      item.querySelector('[data-notification-seen]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          if (!current()) return;
          const { data, error } = await getSupabase().rpc('mark_care_notification_seen', { p_id: row.id });
          if (!current()) return;
          if (error) throw error;
          if (!data?.ok) throw new Error('The notification was not updated. Refresh and try again.');
          await load();
        } catch (error) {
          if (!current()) return;
          const errorEl = mount.querySelector('[data-notification-error]');
          errorEl.textContent = 'Could not mark seen: ' + (error?.message || 'Please try again.');
          errorEl.hidden = false;
          button.disabled = false;
        }
      });
    });
  }
  await load();
}

function notificationHref(row) {
  if (row.kind === 'nutrition_request') return '#nutrition-tracker?request=' + encodeURIComponent(row.request_id || '');
  if (row.kind === 'session_request') return '#sessions?session=' + encodeURIComponent(row.session_id || '');
  return '#patients/' + encodeURIComponent(row.patient_id || '');
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}
