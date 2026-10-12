// ============================================================
// New interns ramp up gradually (Fixboard #21, sql/185). On the Team page:
// where each intern is in her first two weeks, and the manager's controls
// (start or stop the ramp-up, her last day). Days are WORKING days.
//   days 1 to 7    as many calls a day as the day number
//   days 1 to 14   only families already in touch, handed over each day
//                  from a leaver (last day near) or the fullest caseloads
//   day 15 on      like everyone else, new leads included
// Nothing is handed to an account that has never signed in.
// ============================================================
import { getSupabase } from '../supabase.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';

const RAMP_ROLES = new Set(['caller', 'caregiver_mentor']);
const isoDay = (d) => String(d || '').slice(0, 10);
// A date column arrives as an ISO timestamp at midnight UTC of the day before
// in some drivers; the database's own date is what matters, so read the day.
const fmt = (d) => {
  const s = isoDay(d);
  if (!s) return '';
  const [y, m, dd] = s.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

export async function loadTeamRamp() {
  const { data, error } = await getSupabase().rpc('team_ramp');
  if (error) throw error;
  const byId = {};
  (data || []).forEach((r) => { byId[r.member_id] = r; });
  return byId;
}

/** Badges for a team card: ramp-up day and today's number, and a last day. */
export function rampBadges(r) {
  if (!r) return '';
  const out = [];
  if (r.ramp_active) {
    const today = r.cap_today ? `up to ${Number(r.cap_today)} call${Number(r.cap_today) === 1 ? '' : 's'} today` : 'regular calls';
    out.push(`<span class="badge badge-info" title="Ramping up: ${today}, only families already in touch until working day 14. New leads from ${sanitize(fmt(r.new_leads_from))}.">Ramp-up day ${Number(r.ramp_day)} of 14 · ${today}</span>`);
    if (r.signed_in === false) out.push('<span class="badge badge-warn" title="Nothing is handed to her until she signs in for the first time">Not signed in yet</span>');
  }
  if (r.ends_on) out.push(`<span class="badge badge-warn" title="Her families go to new interns ramping up as her last day comes near">Last day ${sanitize(fmt(r.ends_on))}</span>`);
  return out.join('');
}

export const canRamp = (role) => RAMP_ROLES.has(role);

/** The manager's controls for one member. onDone() repaints the Team page. */
export function openRampModal({ id, name, role, ramp }, onDone) {
  const r = ramp || {};
  const el = document.createElement('div');
  const handed = Number(r.handed_over || 0);
  const status = r.ramp_active
    ? `Day <strong>${Number(r.ramp_day)}</strong> of 14 of her ramp-up: ${r.cap_today ? `up to <strong>${Number(r.cap_today)}</strong> call${Number(r.cap_today) === 1 ? '' : 's'} today` : 'regular calls'}, families already in touch only. New leads from ${sanitize(fmt(r.new_leads_from))}. ${handed} famil${handed === 1 ? 'y' : 'ies'} handed to her so far.`
    : r.ramp_started_on ? `Her ramp-up finished (it started ${sanitize(fmt(r.ramp_started_on))}). She gets calls like everyone else.`
      : 'Not ramping up: she gets calls like everyone else.';
  const notes = [
    r.ramp_active && r.signed_in === false ? 'She has not signed in yet, so nothing is handed to her until she does.' : '',
    r.ramp_active && r.on_probation ? 'She is on probation. The ramp-up gives her calls now, but when it ends she gets no automatic calls until probation is lifted.' : '',
  ].filter(Boolean);
  el.innerHTML = `
    ${canRamp(role) ? `
    <div class="form-group">
      <div class="form-label">Gradual ramp-up</div>
      <p class="muted" style="margin:0 0 8px">${status}</p>
      ${notes.map((n) => `<p class="muted" style="margin:0 0 8px;color:var(--warn-ink, inherit)">${sanitize(n)}</p>`).join('')}
      <p class="muted" style="margin:0 0 10px;font-size:13px">Working days 1 to 7: as many calls a day as the day number. Working days 1 to 14: only families already in touch, handed over each day from someone whose last day is near, else from the fullest caseloads. From working day 15: new leads too. A new caregiver mentor starts this the day her account is made; nothing is handed to her until she first signs in.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary btn-sm" id="ramp-start">${r.ramp_active ? 'Start again from day 1' : 'Start ramp-up today'}</button>
        ${r.ramp_active ? '<button type="button" class="btn btn-ghost btn-sm" id="ramp-stop">Stop ramp-up</button>' : ''}
      </div>
    </div>` : ''}
    <div class="form-group" style="margin-top:14px">
      <label class="form-label" for="ramp-ends">Last day (interns)</label>
      <p class="muted" style="margin:0 0 8px;font-size:13px">From 3 weeks before this day, her families go first to new interns ramping up.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="date" class="form-input" id="ramp-ends" value="${sanitize(isoDay(r.ends_on))}" style="max-width:180px" />
        <button type="button" class="btn btn-primary btn-sm" id="ramp-ends-save">Save last day</button>
        ${r.ends_on ? '<button type="button" class="btn btn-ghost btn-sm" id="ramp-ends-clear">Clear</button>' : ''}
      </div>
    </div>`;
  showModal({ title: `${sanitize(name || 'Team member')}: ramp-up and last day`, content: el, size: 'md' });
  const sb = getSupabase();
  const run = async (btn, fn, args, msg) => {
    btn.disabled = true;
    const { error } = await sb.rpc(fn, args);
    btn.disabled = false;
    if (error) { showToast(error.message, 'error'); return; }
    showToast(msg, 'success', 3500);
    closeModal();
    onDone?.();
  };
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // the day in India
  el.querySelector('#ramp-start')?.addEventListener('click', (e) => run(e.currentTarget, 'set_intern_ramp', { p_user: id, p_start: today },
    `${sanitize(name) || 'She'} starts her ramp-up today: 1 call today, 2 tomorrow, families already in touch.`));
  el.querySelector('#ramp-stop')?.addEventListener('click', (e) => run(e.currentTarget, 'set_intern_ramp', { p_user: id, p_start: null },
    'Ramp-up stopped: calls like everyone else from the next build.'));
  el.querySelector('#ramp-ends-save')?.addEventListener('click', (e) => {
    const v = el.querySelector('#ramp-ends').value;
    if (!v) { showToast('Pick a day first.', 'warning'); return; }
    run(e.currentTarget, 'set_member_end_date', { p_user: id, p_ends_on: v }, 'Last day saved.');
  });
  el.querySelector('#ramp-ends-clear')?.addEventListener('click', (e) => run(e.currentTarget, 'set_member_end_date', { p_user: id, p_ends_on: null }, 'Last day cleared.'));
}
