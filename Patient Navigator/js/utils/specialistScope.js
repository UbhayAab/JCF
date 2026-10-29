// View As changes the displayed profile, not the real Supabase subject.
// A manager's whole pool is never evidence of the selected trainee's assignment.
import { getCurrentProfile, getCurrentUser, isImpersonating } from '../auth.js';

export function captureSpecialistScope() {
  const profile = getCurrentProfile();
  const user = getCurrentUser();
  if (!profile?.id || !user?.id || profile.is_active === false) return null;
  return Object.freeze({ id: profile.id, account: user.id, role: profile.role,
    probation: profile.on_probation === true, endsOn: profile.ends_on ?? null, preview: isImpersonating() });
}

export function specialistScopeCurrent(scope, element) {
  const now = captureSpecialistScope();
  return !!scope && !!now && scope.id === now.id && scope.account === now.account
    && scope.role === now.role && scope.probation === now.probation && scope.endsOn === now.endsOn && scope.preview === now.preview
    && (!element || element.isConnected !== false);
}

export const specialistScopeKey = scope => scope ? JSON.stringify(scope) : '';

export async function specialistRows(sb, kind, scope) {
  if (!['care', 'outreach'].includes(kind) || !specialistScopeCurrent(scope)) {
    throw new Error('The selected account changed. Open its worklist again.');
  }
  const name = kind === 'care' ? 'get_nutrition_worklist' : 'get_nutrition_outreach';
  const result = scope.preview
    ? await sb.rpc(name + '_for', { p_user_id: scope.id })
    : await sb.rpc(name);
  if (!specialistScopeCurrent(scope)) throw new Error('The selected account changed. Open its worklist again.');
  if (result?.error || !Array.isArray(result?.data)) {
    // In particular, do not fall back to the real manager's broad no-argument API.
    throw new Error('Could not load this account\'s assigned families. Refresh to try again.');
  }
  return result;
}

export function specialistCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
