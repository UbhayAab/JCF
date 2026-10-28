// ============================================================
// Patient Navigator: Auth Module
// Login, logout, session management
// ============================================================

import * as backend from './supabase.js';
const { getSupabase } = backend;

let authEpoch = 0;
let initPending = null;
let observingAuth = false;
let currentUser = null;
let currentProfile = null;
let impersonatedProfile = null;            // manager/admin "open as user"
let openAsProblem = null;
const IMPERSONATE_KEY = 'jcf_impersonate';
const VIEW_VERSION = 1;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
export function takeOpenAsProblem() { const problem = openAsProblem; openAsProblem = null; return problem; }

export function getUserRole() {
  return (impersonatedProfile || currentProfile)?.role || null;
}

export function isAdmin() { return getUserRole() === 'admin'; }
export function isManagerOrAdmin() { return ['admin', 'manager'].includes(getUserRole()); }

// ---- Master access: open any account (managers & admins only) ----
// No password needed. The manager is already signed in; this just scopes the
// app to the target user. Writes still happen under the real session, which the
// audit log + the "on-behalf" RLS policies permit. Returns true if it started.
function canOwnView() {
  return typeof currentUser?.id === 'string' && PROFILE_ID.test(currentUser.id) && currentProfile?.id === currentUser.id
    && ['admin', 'manager'].includes(currentProfile.role)
    && currentProfile.is_active === true && currentProfile.must_change_password !== true;
}

// This is only a UI selection, never an Auth identity or a permission grant.
// Copy a closed set of fields; do not persist the full profile or credentials.
function viewProfile(profile) {
  if (typeof profile?.id !== 'string' || !PROFILE_ID.test(profile.id) || profile.is_active !== true
      || typeof profile.role !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(profile.role)) return null;
  const id = profile.id.toLowerCase();
  if (id === currentUser?.id?.toLowerCase()) return null;
  const full_name = typeof profile.full_name === 'string' ? profile.full_name.trim().slice(0, 200) : '';
  return { id, full_name: full_name || 'Team member', role: profile.role, is_active: true };
}

async function restoreImpersonation(epoch, ownerId) {
  impersonatedProfile = null;
  let raw;
  try {
    raw = sessionStorage.getItem(IMPERSONATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const profile = viewProfile(saved?.profile);
    if (canOwnView() && saved?.version === VIEW_VERSION && saved.owner_id === currentUser.id && profile) {
      // The stored name/role is a small selection envelope, not authoritative
      // profile data. Reload the real row so probation, role changes and account
      // deactivation cannot be hidden by an old browser snapshot.
      const { data, error } = await withTimeout(getSupabase().from('profiles').select('*').eq('id', profile.id).maybeSingle(), 3000, 'Open as profile');
      if (epoch !== authEpoch || currentUser?.id !== ownerId || sessionStorage.getItem(IMPERSONATE_KEY) !== raw) return;
      if (error || !viewProfile(data) || data.id !== profile.id) throw new Error('Selected profile unavailable');
      impersonatedProfile = { ...data, _impersonated: true };
      return;
    }
  } catch {
    if (epoch !== authEpoch || currentUser?.id !== ownerId) return;
    try { if (raw !== undefined && sessionStorage.getItem(IMPERSONATE_KEY) !== raw) return; } catch {}
    openAsProblem = 'The selected dashboard could not be loaded. Please try Open as again.';
  }
  try { sessionStorage.removeItem(IMPERSONATE_KEY); } catch {}
}

export function startImpersonation(profile) {
  if (!canOwnView()) return false;
  const selected = viewProfile(profile);
  if (!selected) return false;
  const saved = JSON.stringify({ version: VIEW_VERSION, owner_id: currentUser.id, profile: selected });
  try {
    sessionStorage.setItem(IMPERSONATE_KEY, saved);
    if (sessionStorage.getItem(IMPERSONATE_KEY) !== saved) throw new Error('View storage unavailable');
  } catch {
    try { sessionStorage.removeItem(IMPERSONATE_KEY); } catch {}
    return false;
  }
  impersonatedProfile = { ...selected, _impersonated: true };
  return true;
}
export function stopImpersonation() {
  impersonatedProfile = null;
  openAsProblem = null;
  try { sessionStorage.removeItem(IMPERSONATE_KEY); } catch {}
}

// SDK callbacks stay synchronous: no SDK calls while its auth lock is held.
function forgetAuth() {
  authEpoch++;
  initPending = null;
  currentUser = null;
  currentProfile = null;
  stopImpersonation();
}
function observeAuth() {
  if (observingAuth) return;
  observingAuth = true;
  getSupabase().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (session?.user && currentUser && session.user.id !== currentUser.id)) forgetAuth();
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function readSessionFromStorage() {
  try {
    // An older cached factory has no key helper: fail closed, never scan all
    // sb-* keys and accidentally select another project's identity.
    const key = backend.getAuthStorageKey?.();
    if (!key) return null;
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    const session = value?.currentSession || value;
    if (session?.access_token && session?.user?.id && Number(session.expires_at) > Date.now() / 1000) return session;
  } catch { /* blocked, malformed or expired storage is not a session */ }
  return null;
}

// Concurrent startup and SIGNED_IN events share one profile request. A late
// request cannot restore an identity cleared by sign-out or an account change.
export function initAuth() {
  observeAuth();
  if (initPending) return initPending;
  const epoch = authEpoch;
  const pending = initialize(epoch).finally(() => { if (initPending === pending) initPending = null; });
  initPending = pending;
  return pending;
}

async function initialize(epoch) {
  const sb = getSupabase();
  let session = null;
  try {
    const { data, error } = await withTimeout(sb.auth.getSession(), 4000, 'getSession');
    if (error) {
      // Only transient transport/server failure may use a still-valid local
      // session. A successful null session or an auth rejection is final.
      if (!error.status || error.status >= 500) session = readSessionFromStorage();
    } else session = data?.session || null;
  } catch (error) {
    if (!error?.status || error.status >= 500) session = readSessionFromStorage();
  }
  if (epoch !== authEpoch) return null;
  if (!session?.user) { forgetAuth(); return null; }
  if (currentUser?.id !== session.user.id) {
    currentProfile = null;
    // A fresh module has no user yet: preserve its record until the actual
    // owner's profile can validate it. A real account switch still clears it.
    if (currentUser) stopImpersonation();
    else impersonatedProfile = null;
  }
  currentUser = session.user;
  let status = 'error';
  try { status = await withTimeout(loadProfile(epoch, session.user.id), 6000, 'loadProfile'); }
  catch { /* Account recovery offers Retry without deleting a valid sign-in. */ }
  if (epoch !== authEpoch) return null;
  if (status === 'missing') { await clearSession(); return null; }
  // JWT query rejection is not evidence that every device should be logged
  // out. Do not mount a role-less shell; gateAndBoot offers account recovery.
  if (status === 'invalid') currentProfile = null;
  // Keep the selected-profile lookup outside loadProfile's timeout race. Its
  // own bounded request must finish before a shell can mount for this boot.
  if (status === 'ok') {
    await restoreImpersonation(epoch, session.user.id);
    if (epoch !== authEpoch || currentUser?.id !== session.user.id) return null;
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
async function loadProfile(epoch = authEpoch, userId = currentUser?.id) {
  if (!userId) return 'error';
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (epoch !== authEpoch || currentUser?.id !== userId) return 'stale';

  if (error) {
    console.error('Failed to load profile:', error);
    return ['PGRST301', 'PGRST303'].includes(error.code) ? 'invalid' : 'error';
  }

  if (!data) {
    console.error('[auth] account profile unavailable');
    return 'missing';
  }

  currentProfile = data;

  return 'ok';
}

// ---- Hard session teardown ----
// Used when the session is unusable (no profile row / rejected token):
// best-effort server sign-out, then guarantee the local tokens are gone so
// the next boot lands cleanly on the login screen instead of a broken shell.
export async function clearSession() {
  const key = backend.getAuthStorageKey?.();
  let prior;
  try { prior = key ? localStorage.getItem(key) : null; } catch { /* blocked */ }
  forgetAuth();
  try { await withTimeout(getSupabase().auth.signOut({ scope: 'local' }), 3000, 'signOut'); }
  catch { console.warn('[auth] local session teardown unavailable'); }
  try {
    // Do not erase a newer sign-in that finished while the SDK was pending.
    if (key && !currentUser && localStorage.getItem(key) === prior) localStorage.removeItem(key);
  } catch { /* SDK still owns its local teardown */ }
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
  forgetAuth();
  currentUser = data.user;
  const epoch = authEpoch;
  try {
    const status = await loadProfile(epoch, data.user.id);
    if (epoch !== authEpoch) throw new Error('Sign-in changed. Please try again.');
    // We JUST authenticated, so 'missing' here is definitive, not a network
    // blip: the account exists in auth but has no profile row. Block it with
    // a clear message instead of letting it into a half-broken app.
    if (status === 'missing') {
      await clearSession();
      throw new Error('This account has no user profile in the system. Please contact your administrator.');
    }
  } catch (err) {
    if (/no user profile|Sign-in changed/.test(err.message || '')) throw err;
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
  // A call recording shared into the app and not used yet never outlives the
  // session on this phone (sw.js share target, Fixboard #22).
  try { if ('caches' in window) await caches.delete('jcf-shared-recording'); } catch { /* none kept */ }
  const { error } = await sb.auth.signOut();
  if (error) throw new Error(error.message);
  forgetAuth();
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
