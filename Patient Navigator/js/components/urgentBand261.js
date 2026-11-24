import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentProfile, getUserRole } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { concernReason } from '../utils/catalog.js';
import { navigate } from '../router.js';
import { showToast } from './toast.js';

const mounts = new WeakMap();
const DAY = 86400000;

export function canAcknowledgeUrgent(role) {
  return ['admin', 'manager'].includes(role);
}

export function sortUrgentFlags(rows) {
  return [...rows].sort((a, b) =>
    Number(b.reason === 'self_harm') - Number(a.reason === 'self_harm') ||
    Number(a.status === 'acknowledged') - Number(b.status === 'acknowledged') ||
    new Date(a.created_at) - new Date(b.created_at));
}

export function urgentBandFailureHTML() {
  return '<p class="urgent-band261-error" role="status">Could not load the families who need a person now. <button type="button" class="btn btn-ghost btn-sm" data-urgent-retry>Retry</button></p>';
}

export function urgentBandHTML(rows, { role, now = new Date() } = {}) {
  if (!rows.length) return '';
  return `<section class="urgent-band261" aria-label="Families who need a person now">
    <h2>Needs a person now: ${rows.length}</h2>
    ${sortUrgentFlags(rows).map(row => {
      const selfHarm = row.reason === 'self_harm';
      const days = Math.max(0, Number(row.days_open) || 0);
      const reachedDays = Math.max(0, Math.floor((new Date(now) - new Date(row.last_connected_at)) / DAY));
      const contact = row.connected_since && row.last_connected_at
        ? `Last reached ${reachedDays} ${reachedDays === 1 ? 'day' : 'days'} ago`
        : 'Not reached since this was raised';
      const waiting = row.waiting_call_since
        ? 'A call has been waiting since ' + new Date(row.waiting_call_since).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'}) : '';
      return `<article class="urgent-band261-row">
        <div class="urgent-band261-family">
          <strong>${sanitize(row.full_name || 'Family')}</strong>
          <span class="${selfHarm ? 'urgent-band261-danger' : ''}">${sanitize(selfHarm ? 'Talk of self-harm' : concernReason(row.reason).label)}</span>
          <span>Open ${days} ${days === 1 ? 'day' : 'days'}</span>
          <span>${sanitize(contact)}</span>
          ${waiting ? `<span>${sanitize(waiting)}</span>` : ''}
          ${row.status === 'acknowledged' ? `<span>Seen by ${sanitize(row.acknowledger_name || 'a team member')}</span>` : ''}
        </div>
        <div class="urgent-band261-actions">
          ${row.status === 'open' && canAcknowledgeUrgent(role) ? `<button type="button" class="btn btn-danger btn-sm" data-urgent-ack="${sanitize(String(row.concern_id))}">I'm on it</button>` : ''}
          <button type="button" class="btn btn-secondary btn-sm" data-urgent-open="${sanitize(String(row.patient_id))}">Open the record</button>
        </div>
      </article>`;
    }).join('')}
  </section>`;
}

export async function renderUrgentBand(el, { scope = 'visible' } = {}) {
  if (!el) return;
  const token = {};
  mounts.set(el, token);
  const profile = getCurrentProfile();
  const role = getUserRole();
  const current = () => mounts.get(el) === token && el.isConnected && getCurrentProfile() === profile && getUserRole() === role;
  let rows = [];
  function paint() {
    if (!current()) return;
    el.innerHTML = urgentBandHTML(rows, { role });
    el.querySelectorAll('[data-urgent-open]').forEach(button => button.addEventListener('click', () => {
      if (current()) navigate('patients/' + button.dataset.urgentOpen);
    }));
    el.querySelectorAll('[data-urgent-ack]').forEach(button => button.addEventListener('click', async () => {
      if (!current() || !canAcknowledgeUrgent(getUserRole())) return;
      button.disabled = true;
      const id = button.dataset.urgentAck;
      const patch = { status: 'acknowledged', acknowledged_by: profile.id, acknowledged_at: new Date().toISOString() };
      try {
        await mustWrite(getSupabase().from('patient_concerns').update(patch).eq('id', id).eq('status', 'open'), 'concern');
        if (!current()) return;
        rows = rows.map(row => String(row.concern_id) === id ? { ...row, ...patch, acknowledger_name: profile.full_name } : row);
        showToast("Marked as yours. It's being handled", 'success');
        paint();
      } catch (error) {
        if (!current()) return;
        button.disabled = false;
        showToast('Could not update: ' + error.message, 'error');
      }
    }));
  }
  try {
    const sb = getSupabase();
    // Two ordered reads preserve self-harm priority BEFORE the 200-row cap.
    // RLS remains authoritative; own scope also covers a manager opening as a caller.
    const load = async (selfHarm, limit) => {
      let query = sb.from('v_urgent_flags261').select('*');
      if (scope === 'own') query = query.eq('owner_id', profile?.id);
      query = selfHarm ? query.eq('reason', 'self_harm') : query.neq('reason', 'self_harm');
      const { data, error } = await query.order('status', { ascending: false })
        .order('created_at', { ascending: true }).order('concern_id', { ascending: true }).limit(limit);
      if (error || !Array.isArray(data)) throw error || new Error('Unavailable');
      return data;
    };
    rows = await load(true, 200);
    if (!current()) return;
    if (rows.length < 200) rows.push(...await load(false, 200 - rows.length));
    if (!current()) return;
    if (!rows.length) { paint(); return; }
    const ids = [...new Set(rows.map(row => row.patient_id))];
    const { data: patients, error } = await sb.from('patients').select('id,full_name,patient_code').in('id', ids);
    if (error || !Array.isArray(patients)) throw error || new Error('Unavailable');
    if (!current()) return;
    const byId = new Map(patients.map(patient => [patient.id, patient]));
    // A family disappearing under RLS between reads must not leave an identifying link.
    rows = rows.filter(row => byId.has(row.patient_id)).map(row => ({ ...row, ...byId.get(row.patient_id) }));
    const staffIds = [...new Set(rows.map(row => row.acknowledged_by).filter(Boolean))];
    if (staffIds.length) {
      const { data: staff, error: staffError } = await sb.from('profiles').select('id,full_name').in('id', staffIds);
      if (staffError || !Array.isArray(staff)) throw staffError || new Error('Unavailable');
      const names = new Map(staff.map(person => [person.id, person.full_name]));
      rows = rows.map(row => ({ ...row, acknowledger_name: names.get(row.acknowledged_by) }));
    }
    paint();
  } catch {
    if (!current()) return;
    el.innerHTML = urgentBandFailureHTML();
    el.querySelector('[data-urgent-retry]')?.addEventListener('click', () => {
      if (current()) renderUrgentBand(el, { scope });
    });
  }
}
