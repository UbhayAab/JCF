// ============================================================
// Who does a HopeBot request, a WhatsApp lead or a document collection go
// to (sql/182, 183). Managers pick from the people who can call today,
// lightest first; "Automatic" hands it back to the rule. Also the words for
// why something went to someone, and for each line of its history.
// Everything from the database goes through sanitize() before innerHTML.
// ============================================================
import { getSupabase } from '../supabase.js';
import { sanitize } from '../utils/validators.js';

const cache = new Map(); // team -> { at, rows }

export async function loadRoster(team) {
  const key = team || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.rows;
  const { data, error } = await getSupabase().rpc('hopebot_assignable', { p_team: team || null });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  cache.set(key, { at: Date.now(), rows });
  return rows;
}
export const forgetRoster = () => cache.clear();

const ROLE = { caregiver_mentor: 'mentor', caller: 'mentor', nutritionist: 'nutrition', therapist: 'therapist', manager: 'manager', admin: 'admin' };

/** A select of people; value '' = automatic. `count` names the load to show. */
export function rosterSelectHTML(rows, current, { attr = 'data-assign', id = '', count = 'open_requests', auto = 'Automatic: let the rule pick', currentName = '', onlyTeam = false } = {}) {
  const list = (rows || []).filter((r) => !onlyTeam || r.team_match);
  // Someone who cannot call today is not in the list, but still holds it: show them.
  const held = current && !list.some((r) => r.id === current)
    ? `<option value="${sanitize(current)}" selected>${sanitize(currentName || 'Current caller')} · cannot call today</option>` : '';
  const opts = held + list.map((r) => {
    const n = Number(r[count] || 0);
    const bits = [ROLE[r.role] || r.role, `${n} open`];
    if (!r.team_match) bits.push('other team');
    return `<option value="${sanitize(r.id)}" ${r.id === current ? 'selected' : ''}>${sanitize(r.name || 'Unnamed')} · ${sanitize(bits.join(' · '))}</option>`;
  }).join('');
  return `<select class="form-select" ${attr}="${sanitize(id)}" aria-label="Assign to" style="max-width:100%;min-width:0;width:auto;font-size:13px;padding:6px 28px 6px 10px">
      <option value="" ${current ? '' : 'selected'}>${sanitize(auto)}</option>${opts}</select>`;
}

export const REASON = {
  family_carer: "the family's own caregiver",
  nutrition_owner: "the family's nutritionist",
  lead_owner: 'already calls this family',
  same_family: 'called this family before',
  marked_it: 'marked them ready',
  round_robin: 'on shift, with the fewest open calls',
  manager: 'chosen by a manager',
  took_it: 'took the call',
  handed_back: 'handed on',
  reassigned: 'their caller is off today',
  nobody_on_shift: 'nobody on shift',
  existing_work: 'was already working on it',
};
export const reasonText = (r) => REASON[r] || '';

const when = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const CLOSED = { reached: 'Reached', wrong_number: 'Wrong number', not_needed: 'Not needed', unreachable: 'Unreachable after 3 tries',
  collected: 'All papers collected', declined: 'Does not want to share now' };

/** One history line. */
export function eventLine(e) {
  const by = e.by ? sanitize(e.by) : null;
  const to = e.to ? sanitize(e.to) : null;
  const known = Object.prototype.hasOwnProperty.call(REASON, e.detail || '');
  const d = e.detail ? sanitize(e.detail) : '';
  const what = {
    assigned: `Given to ${to || 'someone'}${by ? ` by ${by}` : ' automatically'}${known ? ` (${REASON[e.detail]})` : d ? ` (${d})` : ''}`,
    unassigned: `Waiting for a manager${known ? ` (${REASON[e.detail]})` : d ? ` (${d})` : ''}`,
    taken: `${by || 'Someone'} said "I will call"`,
    released: `${by || 'Someone'} gave the call back`,
    handed_back: `${by || 'Someone'} handed it on`,
    no_answer: `No answer${d ? ` (${d})` : ''}${by ? `, ${by}` : ''}`,
    call_back: `Call back ${d}${by ? `, ${by}` : ''}`,
    reached: `Reached, they will send${by ? `, ${by}` : ''}${d ? `: ${d}` : ''}`,
    closed: `Closed: ${sanitize(CLOSED[e.detail] || e.detail || '')}${by ? `, ${by}` : ''}`,
    marked: `Marked ready to share${by ? ` by ${by}` : ''}${d ? ` (${d.replace(/_/g, ' ')})` : ''}`,
    arrived: `Papers arrived: ${d}`,
    collected: `All papers collected${by ? `, ${by}` : ''}`,
    not_needed: `Not needed any more${by ? `, ${by}` : ''}`,
    declined: `Does not want to share now${by ? `, ${by}` : ''}`,
    reopened: `Reopened: still missing some${by ? `, ${by}` : ''}`,
  }[e.kind] || sanitize(e.kind);
  return `<div class="due-meta wraps"><span style="color:var(--ink-3)">${when(e.at)}</span> · ${what}</div>`;
}

export function historyHTML(events) {
  if (!Array.isArray(events) || !events.length) return '';
  return `<details style="margin-top:8px"><summary class="due-meta" style="cursor:pointer;color:var(--ink-1)">History</summary>
    <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">${events.map(eventLine).join('')}</div></details>`;
}
