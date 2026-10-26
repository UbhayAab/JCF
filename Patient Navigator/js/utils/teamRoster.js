// Bound roster UI only. Existing server permissions remain authoritative.
import { getCurrentUser, getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';

let generation = 0;
export const memberId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function captureTeamActor() {
  const user = getCurrentUser()?.id, profile = getCurrentProfile()?.id;
  return () => !!user && !!profile && isManagerOrAdmin()
    && getCurrentUser()?.id === user && getCurrentProfile()?.id === profile;
}
export function beginTeamRoster(tab) {
  const content = document.getElementById('team-content'), ownsActor = captureTeamActor();
  const mounted = () => !!content?.isConnected && document.getElementById('team-content') === content
    && document.querySelector('#team-tabs .tab.active')?.dataset.tab === tab && ownsActor();
  // Stale callbacks cannot invalidate the current tab's pending read.
  if (!mounted()) return null;
  const ticket = ++generation;
  return { content, isCurrent: () => ticket === generation && mounted() };
}
export function probationRoster(result) {
  const byId = Object.create(null);
  if (!result || result.error || !Array.isArray(result.data)) return { ok: false, byId };
  for (const p of result.data) {
    // The native RPC deliberately returns NULL when the member is off probation.
    const answered = p?.on_probation === false && p.answered === null ? 0
      : typeof p?.answered === 'string' && /^\d+$/.test(p.answered) ? Number(p.answered) : p?.answered;
    if (!memberId(p?.member_id) || typeof p.on_probation !== 'boolean'
      || !Number.isSafeInteger(answered) || answered < 0 || byId[p.member_id]) return { ok: false, byId: Object.create(null) };
    byId[p.member_id] = { on_probation: p.on_probation, answered };
  }
  return { ok: true, byId };
}
export function bindProbationControls(view, sb, reload) {
  view.content.querySelectorAll('.prob-toggle').forEach(btn => btn.addEventListener('click', async () => {
    if (!view.isCurrent() || !btn.isConnected || btn.disabled || !memberId(btn.dataset.id)
      || !['true', 'false'].includes(btn.dataset.on)) return;
    const desired = btn.dataset.on !== 'true';
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc('set_probation', { p_user: btn.dataset.id, p_on: desired });
      if (!view.isCurrent()) return;
      if (error || data?.ok !== true || data.on !== desired) throw new Error('unconfirmed');
      showToast(desired ? 'Probation enabled. Ask the intern to Refresh app.' : 'Probation ended. Ask the intern to Refresh app. Assignment rules still apply.', 'success');
    } catch {
      if (!view.isCurrent()) return;
      showToast('Could not confirm the probation change. Reloading the current status; no result has been assumed.', 'error');
    }
    if (view.isCurrent()) await reload();
  }));
}
