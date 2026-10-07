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
import { getCurrentProfile } from '../auth.js';

const CORE = {
  caregiver: ['calling', 'learn', 'profile'],
  nutrition: ['nutrition', 'learn', 'profile'],
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

let state = null;            // my_probation(): { on, since, answered, unlock_some, unlock_all }
let stateFor = null;
let loadedAt = 0;
let loading = null;

/** 'core', 'some' or 'all'. On probation but not yet counted: 'core', the safe side. */
export function probationLevel() {
  const profile = getCurrentProfile();
  if (!profile?.on_probation) return 'all';
  if (!state || stateFor !== profile.id) return 'core';
  if (!state.on) return 'all';
  const n = Number(state.answered) || 0;
  if (n >= Number(state.unlock_all)) return 'all';
  if (n >= Number(state.unlock_some)) return 'some';
  return 'core';
}

const teamOf = (role) => (role === 'nutritionist' ? 'nutrition' : 'caregiver');

/** Whether a route is open now. A family's own record ('patients/<id>') stays open: RLS limits it to hers. */
export function routeOpen(route, role) {
  const level = probationLevel();
  if (level === 'all') return true;
  const path = String(route || '').replace(/^#/, '').split('?')[0];
  if (path.startsWith('patients/')) return true;
  const top = path.split('/')[0];
  if (CORE[teamOf(role)].includes(top)) return true;
  return level === 'some' && STEP_ONE.includes(top);
}

/** Where someone on probation lands when a route is not open yet. */
export const homeFor = (role) => (role === 'nutritionist' ? 'nutrition' : 'calling');

/** The line for the menu card; '' when nothing is locked. */
export function progressLine() {
  const level = probationLevel();
  if (level === 'all') return '';
  if (!state) return 'Training: counting your calls...';
  const n = Number(state.answered) || 0;
  return level === 'core'
    ? `Training: ${n} of ${state.unlock_some} calls done. Next to unlock: Patients, Call Logs and Resources.`
    : `Training: ${n} of ${state.unlock_all} calls done. Next to unlock: every tab of your role.`;
}

/**
 * Reads my_probation() when it is missing or a minute old. Resolves true when
 * the level changed, so the menu can redraw. Never throws: on failure the
 * menu keeps what it had.
 */
export function ensureProbation() {
  const profile = getCurrentProfile();
  if (!profile?.on_probation) return Promise.resolve(false);
  if (stateFor === profile.id && Date.now() - loadedAt < STALE_MS) return Promise.resolve(false);
  if (loading) return loading;
  const before = probationLevel();
  loading = (async () => {
    try {
      const { data, error } = await getSupabase().rpc('my_probation');
      if (error) throw error;
      state = data || null;
      stateFor = profile.id;
    } catch (e) {
      console.warn('[probation] could not count the calls yet:', e?.message || e);
    } finally {
      loadedAt = Date.now();
      loading = null;
    }
    return probationLevel() !== before;
  })();
  return loading;
}

/**
 * What opened since she last looked, once per step: a list of { label, what }
 * for the first step, 'all' for the last, or null. The first sight only
 * remembers where she is.
 */
export function unlockNews() {
  const profile = getCurrentProfile();
  if (!profile?.id || !state || stateFor !== profile.id) return null;
  const key = `pn_probation_seen:${profile.id}`;
  const level = probationLevel();
  let seen = null;
  try { seen = localStorage.getItem(key); } catch { return null; }
  const remember = () => { try { localStorage.setItem(key, level); } catch { /* private window */ } };
  if (!seen || !(seen in ORDER) || ORDER[level] < ORDER[seen]) { if (state.on) remember(); return null; }
  if (ORDER[level] === ORDER[seen]) return null;
  remember();
  if (level === 'all') return 'all';
  return STEP_ONE.map((r) => ({ route: r, label: LABEL[r], what: WHAT[r] }));
}
