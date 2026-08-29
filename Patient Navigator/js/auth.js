// ============================================================
// Patient Navigator: Auth Module
// Login, logout, session management
// ============================================================

import { getSupabase } from './supabase.js';

let currentUser = null;
let currentProfile = null;
let impersonatedProfile = null;            // manager/admin "open as user"
const IMPERSONATE_KEY = 'jcf_impersonate';
const SIGNUP_DISABLED_MESSAGE = 'Sign up is currently disabled. Only admins can add new users manually as of now.';
const PASSWORD_RESET_DISABLED_MESSAGE = 'Password reset is currently disabled. Only an admin can reset it.';

// ---- Get current session & profile ----
export function getCurrentUser() { return currentUser; }
// The "effective" profile. A manager/admin can open any account ("master
// access" the org asked for): the whole UI then acts as the target, while the
// underlying Supabase session (and therefore RLS) stays the real manager.
export function getCurrentProfile() { return impersonatedProfile || currentProfile; }
export function getRealProfile() { return currentProfile; }
export function isImpersonating() { return !!impersonatedProfile; }

export function getUserRole() {
  return (impersonatedProfile || currentProfile)?.role || null;
}

export function isAdmin() { return getUserRole() === 'admin'; }
export function isManagerOrAdmin() { return ['admin', 'manager'].includes(getUserRole()); }

// ---- Master access: open any account (managers & admins only) ----
// No password needed. The manager is already signed in; this just scopes the
// app to the target user. Writes still happen under the real session, which the
// audit log + the "on-behalf" RLS policies permit. Returns true if it started.
export function startImpersonation(profile) {
  if (!['admin', 'manager'].includes(currentProfile?.role)) return false;
  if (!profile?.id || profile.id === currentProfile.id) return false;
  impersonatedProfile = { id: profile.id, full_name: profile.full_name, role: profile.role, is_active: true, _impersonated: true };
  try { sessionStorage.setItem(IMPERSONATE_KEY, JSON.stringify(impersonatedProfile)); } catch {}
  return true;
}
export function stopImpersonation() {
  impersonatedProfile = null;
  try { sessionStorage.removeItem(IMPERSONATE_KEY); } catch {}
}

// ---- Helper: wrap a promise with a hard timeout ----
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ---- Read the Supabase session directly from localStorage ----
// Supabase JS persists sessions at key "sb-{project-ref}-auth-token".
// If getSession() hangs on its network refresh, we still want to honor the
// session that's already stored locally. The user logged in successfully,
// the access_token is right there, we should let them into the app.
function readSessionFromStorage() {
  if (typeof localStorage === 'undefined') return null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw);
      // Some Supabase versions wrap the session under a "currentSession" key.
      const session = value?.currentSession || value;
      if (session?.access_token && session?.user) {
        // A token that expired long ago is a zombie: booting with it renders
        // an unauthenticated shell where RLS rejects everything and there is
        // no way back to the login screen. Within 48h we still accept it.
        // getSession() may refresh it once the network cooperates.
        const expiresAt = Number(session.expires_at || 0);   // epoch seconds
        if (expiresAt && Date.now() / 1000 - expiresAt > 48 * 3600) {
          console.warn('[auth] stored session expired long ago, ignoring it');
          continue;
        }
        return session;
      }
    } catch (e) {
      console.warn('[auth] could not parse stored session at', key, e);
    }
  }
  return null;
}

// ---- Initialize auth (check existing session) ----
// Two-stage: try the official getSession (which can hit the network to
// refresh the token), and if it times out OR errors, fall back to whatever
// Supabase already wrote to localStorage. RLS will reject any stale token
// at the DB layer, but the user reaches the app shell instead of being
// stranded on the login screen.
export async function initAuth() {
  const sb = getSupabase();
  if (!sb) return null;

  let session = null;

  // Stage 1: try the official client (fast path)
  try {
    const { data, error } = await withTimeout(sb.auth.getSession(), 4000, 'getSession');
    if (!error && data?.session?.user) {
      session = data.session;
    } else if (error) {
      console.warn('[auth] getSession returned error:', error.message);
    }
  } catch (timeoutErr) {
    console.warn('[auth] ' + timeoutErr.message + ', falling back to localStorage');
  }

  // Stage 2: localStorage fallback
  if (!session) {
    session = readSessionFromStorage();
    if (session) console.log('[auth] using cached session from localStorage');
  }

  if (!session?.user) {
    currentUser = null;
    currentProfile = null;
    return null;
  }

  currentUser = session.user;
  // Profile load MUST be awaited now that we have RBAC, otherwise the
  // sidebar renders empty, but never let a hung request strand the
  // user on the boot screen: time out, boot anyway, retry in background.
  let profileStatus = 'error';
  try {
    profileStatus = await withTimeout(loadProfile(), 6000, 'loadProfile');
  } catch (err) {
    console.warn('[auth] loadProfile failed:', err);
    setTimeout(() => loadProfile().catch(() => {}), 1500);
  }
  // Definitively unusable session (profile row gone, or token rejected):
  // tear it down and land on the login screen, never boot a broken shell.
  if (profileStatus === 'missing' || profileStatus === 'invalid') {
    console.warn('[auth] session has no usable profile (' + profileStatus + '), signing out');
    await clearSession();
    return null;
  }
  return session;
}

// ---- Load user profile from profiles table ----
// Returns a status the callers act on:
//   'ok':       profile loaded
//   'missing':  query succeeded, no row: the account has no profile (deleted
//               or never created). The session is unusable, sign it out.
//   'invalid':  the token itself was rejected (expired / bad JWT).
//   'error':    transient failure (network, RLS hiccup); worth retrying.
async function loadProfile() {
  if (!currentUser) return 'error';
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .maybeSingle();

  if (error) {
    console.error('Failed to load profile:', error);
    return /jwt|token|expired|invalid/i.test(error.message || '') ? 'invalid' : 'error';
  }

  if (!data) {
    console.error('Profile not found for user ID:', currentUser.id);
    return 'missing';
  }

  currentProfile = data;

  // Restore an in-progress "open as user" session, but ONLY if the real
  // account is a manager/admin (a plain user must never inherit it).
  try {
    const raw = sessionStorage.getItem(IMPERSONATE_KEY);
    if (raw && ['admin', 'manager'].includes(currentProfile.role)) impersonatedProfile = JSON.parse(raw);
    else if (raw) sessionStorage.removeItem(IMPERSONATE_KEY);
  } catch {}
  return 'ok';
}

// ---- Hard session teardown ----
// Used when the session is unusable (no profile row / rejected token):
// best-effort server sign-out, then guarantee the local tokens are gone so
// the next boot lands cleanly on the login screen instead of a broken shell.
export async function clearSession() {
  stopImpersonation();
  try { await withTimeout(getSupabase().auth.signOut(), 3000, 'signOut'); } catch (e) { console.warn('[auth] signOut during teardown failed:', e.message); }
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) stale.push(key);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {}
  currentUser = null;
  currentProfile = null;
}

// ---- Sign In ----
// Profile load is intentionally non-blocking so a slow/failing profiles
// query (RLS, network, etc.) can never trap the user on the login screen.
// The is_active check happens in the background and shows a warning toast
// instead of bouncing the user; RLS at the DB layer is the real gate.
export async function signIn(email, password) {
  const sb = getSupabase();
  stopImpersonation();                 // a fresh sign-in is never an "open as" session
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  currentUser = data.user;
  try {
    const status = await loadProfile();
    // We JUST authenticated, so 'missing' here is definitive, not a network
    // blip: the account exists in auth but has no profile row. Block it with
    // a clear message instead of letting it into a half-broken app.
    if (status === 'missing') {
      await clearSession();
      throw new Error('This account has no user profile in the system. Please contact your administrator.');
    }
  } catch (err) {
    if (/no user profile/.test(err.message || '')) throw err;
    console.warn('[auth] loadProfile failed:', err);
  }
  return data;
}

// ---- Sign Up / outbound auth email flows are disabled ----
export async function signUp() {
  throw new Error(SIGNUP_DISABLED_MESSAGE);
}

export async function sendSignupOtp() {
  throw new Error(SIGNUP_DISABLED_MESSAGE);
}

export async function verifySignupOtp() {
  throw new Error(SIGNUP_DISABLED_MESSAGE);
}

// ---- Forgot password: disabled, admins reset manually ----
export async function sendPasswordReset() {
  throw new Error(PASSWORD_RESET_DISABLED_MESSAGE);
}

// ---- Sign Out ----
export async function signOut() {
  const sb = getSupabase();
  stopImpersonation();                 // never carry an "open as" session past logout
  const { error } = await sb.auth.signOut();
  if (error) throw new Error(error.message);
  currentUser = null;
  currentProfile = null;
}

// ---- Update own profile ----
export async function updateProfile(updates) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .update({
      full_name: updates.full_name,
      phone: updates.phone,
      updated_at: new Date().toISOString(),
    })
    .eq('id', currentUser.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  currentProfile = data;
  return data;
}

// ---- Change password ----
export async function changePassword(newPassword) {
  const sb = getSupabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}
