// ============================================================
// Patient Navigator: On probation (Fixboard #21 and #23)
// Someone on probation sees only the core of her work. The rest of the menu
// opens in two steps, after real conversations (answered calls), so a new
// intern meets the tabs one at a time. The database decides who is on
// probation and counts the calls (my_probation(), sql/163), and RLS already
// limits her to the families given to her by hand; this module only decides
// which tabs show and which routes open.
// ============================================================
import { getSupabase } from '../supabase.js';
import { getCurrentProfile, getCurrentUser, isImpersonating } from '../auth.js';

const CORE = {
  caregiver: ['medical-navigation', 'calling', 'patients', 'dashboard', 'nutrition-tracker', 'updates', 'learn', 'staff-reminders', 'profile'],
  nutrition: ['nutrition', 'dashboard', 'nutrition-tracker', 'updates', 'learn', 'staff-reminders', 'profile'],
};
const STEP_ONE = ['patients', 'calls', 'resources'];
const LABEL = { patients: 'Patients', calls: 'Call Logs', resources: 'Resources' };
const WHAT = {
  patients: 'every family you look after, with their record',
  calls: 'the calls you have logged, to read before the next one',
  resources: 'help you can share with a family: places, schemes and support',
};
const ORDER = { core: 0, some: 1, all: 2 };
const STALE_MS = 60 * 1000;

let state = null;            // probation_access224(): actor-bound selected account
let stateFor = null;
let loadedAt = 0;
let loading = null;
let generation = 0;
let refreshTimer = null;
// set_probation can flag any legacy role. Medical navigation keeps its closed
// native API and explicit route list; all other roles read the actual flag.
const tracksProbation = profile => !!profile?.id && profile.role !== 'medical_navigator';
export const PROBATION_EVENT224 = 'pn:probation-access224';
function identity() {
  const profile = getCurrentProfile(), user = getCurrentUser();
  return { profile, user, key: JSON.stringify([user?.id, profile?.id, profile?.role,
    profile?.on_probation, profile?.probation_since, profile?.is_active, profile?.ends_on, isImpersonating()]) };
}
function sameIdentity(a, b = identity()) {
  return !!a && a.key === b.key && a.profile === b.profile && a.user === b.user;
}
function currentState() {
  return sameIdentity(stateFor) && Date.now() - loadedAt < STALE_MS ? state : null;
}
function announce(phase) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(PROBATION_EVENT224, { detail: { phase } }));
  }
}
function refreshCurrent() {
  if (!sameIdentity(stateFor) || !tracksProbation(getCurrentProfile())) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!currentState()) announce('expired');
  void ensureProbation();
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCurrent, STALE_MS + 1);
  refreshTimer?.unref?.();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refreshCurrent);

/** 'core', 'some' or 'all'. On probation but not yet counted: 'core', the safe side. */
export function probationLevel() {
  const profile = getCurrentProfile();
  if (!tracksProbation(profile)) return 'all';
  const verified = currentState();
  if (!verified) return 'core';
  if (!verified.on) return 'all';
  const n = verified.answered;
  if (n >= verified.unlock_all) return 'all';
  if (n >= verified.unlock_some) return 'some';
  return 'core';
}

const teamOf = (role) => (role === 'nutritionist' ? 'nutrition' : 'caregiver');
const stepOneFor = (role) => STEP_ONE.filter(r => !CORE[teamOf(role)].includes(r));

/** Whether a route is open now. A family's own record ('patients/<id>') stays open: RLS limits it to hers. */
export function routeOpen(route, role) {
  if (role === 'medical_navigator') return ['medical-navigation', 'profile', 'login'].includes(String(route || '').replace(/^#/, '').split('?')[0]);
  const level = probationLevel();
  if (level === 'all') return true;
  const full = String(route || '').replace(/^#/, '');
  const path = full.split('?')[0];
  if (path.startsWith('patients/')) return true;
  // A notification can open its exact session during training. The session
  // page checks care access and keeps the full worklist behind its usual gate.
  if (path === 'sessions' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(new URLSearchParams(full.split('?')[1] || '').get('session') || '')) return true;
  const top = path.split('/')[0];
  if (CORE[teamOf(role)].includes(top)) return true;
  return level === 'some' && STEP_ONE.includes(top);
}

/** Where someone on probation lands when a route is not open yet. */
export const homeFor = (role) => (role === 'medical_navigator' ? 'medical-navigation' : role === 'nutritionist' ? 'nutrition' : 'calling');

/** The line for the menu card; '' when nothing is locked. */
export function progressLine() {
  const level = probationLevel();
  if (level === 'all') return '';
  const verified = currentState();
  if (!verified) return 'Training access is not verified yet. Refresh to try again.';
  const n = verified.answered;
  const next = stepOneFor(getCurrentProfile()?.role).map(r => LABEL[r]).join(' and ');
  return level === 'core'
    ? `Training: ${n} of ${verified.unlock_some} calls done. Next to unlock: ${next}.`
    : `Training: ${n} of ${verified.unlock_all} calls done. Next to unlock: every tab of your role.`;
}

/**
 * Reads the selected account, authorized by the real actor. A manager's
 * my_probation() is never the selected intern's state. Obsolete requests,
 * expired state and unverifiable responses cannot unlock tabs.
 */
export function ensureProbation() {
  const selected = identity(), { profile, user } = selected;
  if (!tracksProbation(profile)) return Promise.resolve(false);
  if (sameIdentity(stateFor, selected) && Date.now() - loadedAt < STALE_MS) return Promise.resolve(false);
  if (loading && sameIdentity(loading.identity, selected)) return loading.promise;
  const before = probationLevel();
  const request = ++generation;
  clearTimeout(refreshTimer);
  const pending = (async () => {
    let next = null;
    try {
      if (!user?.id || !profile?.id || profile.is_active === false) throw new Error('Account unavailable');
      const controller = new AbortController();
      let deadline;
      const query = getSupabase().rpc('probation_access224', { p_user: profile.id });
      const operation = typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query;
      let response;
      try {
        response = await Promise.race([operation, new Promise((_, reject) => {
          deadline = setTimeout(() => { controller.abort(); reject(new Error('Training access timed out')); }, 8000);
        })]);
      } finally { clearTimeout(deadline); }
      const { data, error } = response;
      if (error || !data || data.actor_id !== user.id || data.user_id !== profile.id || data.role !== profile.role
          || typeof data.on !== 'boolean' || ![data.answered, data.unlock_some, data.unlock_all].every(n => Number.isSafeInteger(n) && n >= 0)
          || data.unlock_all < data.unlock_some || data.unlock_all > 500) throw new Error('Training access unavailable');
      next = data;
    } catch (e) {
      console.warn('[probation] could not verify training access');
    }
    if (request !== generation || !sameIdentity(selected)) return false;
    state = next;
    // Other assigned-family views read the same effective profile. Reflect only
    // this native-verified training flag so graduation does not leave them in
    // the previous training presentation until another login.
    if (next) { profile.on_probation = next.on; profile.probation_since = next.since; }
    stateFor = identity();
    loadedAt = Date.now();
    scheduleRefresh();
    announce(next ? 'verified' : 'unavailable');
    // The first verified count also changes the card when the level is core.
    return !!next || probationLevel() !== before;
  })().finally(() => { if (loading?.request === request) loading = null; });
  loading = { identity: selected, promise: pending, request };
  return pending;
}

/**
 * What opened since she last looked, once per step: a list of { label, what }
 * for the first step, 'all' for the last, or null. The first sight only
 * remembers where she is.
 */
export function unlockNews() {
  const profile = getCurrentProfile();
  if (!profile?.id || !currentState()) return null;
  const key = `pn_probation_seen:${profile.id}`;
  const level = probationLevel();
  let seen = null;
  try { seen = localStorage.getItem(key); } catch { return null; }
  const remember = () => { try { localStorage.setItem(key, level); } catch { /* private window */ } };
  if (!seen || !(seen in ORDER) || ORDER[level] < ORDER[seen]) { if (state.on) remember(); return null; }
  if (ORDER[level] === ORDER[seen]) return null;
  remember();
  if (level === 'all') return 'all';
  return stepOneFor(profile.role).map((r) => ({ route: r, label: LABEL[r], what: WHAT[r] }));
}
