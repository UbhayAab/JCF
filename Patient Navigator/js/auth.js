// ============================================================
// Patient Navigator — Auth Module
// Login, signup, logout, session management
// ============================================================

import { getSupabase } from './supabase.js';
import { showToast } from './components/toast.js';

let currentUser = null;
let currentProfile = null;

// ---- Get current session & profile ----
export function getCurrentUser() { return currentUser; }
export function getCurrentProfile() { return currentProfile; }

export function getUserRole() {
  return currentProfile?.role || null;
}

export function isAdmin() { return getUserRole() === 'admin'; }
export function isManagerOrAdmin() { return ['admin', 'manager'].includes(getUserRole()); }

// ---- Helper: wrap a promise with a hard timeout ----
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ---- Initialize auth (check existing session) ----
// Hard-bounded so a stalled network never leaves the user staring at a spinner.
export async function initAuth() {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data: { session }, error } = await withTimeout(
      sb.auth.getSession(),
      6000,
      'getSession'
    );
    if (error) {
      console.warn('Session check failed:', error.message);
      return null;
    }
    if (session?.user) {
      currentUser = session.user;
      try {
        await withTimeout(loadProfile(), 6000, 'loadProfile');
      } catch (profileErr) {
        console.warn('Profile load failed/timed out:', profileErr.message);
        currentUser = null;
        currentProfile = null;
        return null;
      }
      return session;
    }
    return null;
  } catch (err) {
    console.warn('Session init error:', err.message);
    currentUser = null;
    currentProfile = null;
    return null;
  }
}

// ---- Load user profile from profiles table ----
async function loadProfile() {
  if (!currentUser) return;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();

  if (error) {
    console.error('Failed to load profile:', error);
    return;
  }
  currentProfile = data;
}

// ---- Sign In ----
// Profile load is intentionally non-blocking so a slow/failing profiles
// query (RLS, network, etc.) can never trap the user on the login screen.
// The is_active check happens in the background and shows a warning toast
// instead of bouncing the user; RLS at the DB layer is the real gate.
export async function signIn(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  currentUser = data.user;
  // Fire-and-forget: surface profile errors in the console but never block.
  loadProfile().catch(err => console.warn('[auth] loadProfile failed (non-blocking):', err));
  return data;
}

// ---- Sign Up (legacy password flow) ----
export async function signUp(email, password, fullName) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName }
    }
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// ---- Email-OTP signup, step 1: send 6-digit code to the email ----
// shouldCreateUser:true means a new auth.users row is created on first OTP.
// The on-signup trigger gives them a 'caller' profile with is_active=true,
// but we flip it to false right after verification so admin must approve.
export async function sendSignupOtp(email, fullName) {
  const sb = getSupabase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: { full_name: fullName },
    },
  });
  if (error) throw new Error(error.message);
}

// ---- Email-OTP signup, step 2: verify the code ----
// On success we sign the new user OUT immediately and mark their profile
// inactive — they wait for admin approval before the app lets them in.
export async function verifySignupOtp(email, token, fullName) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(error.message);

  if (data?.user) {
    try {
      // Make sure the profile carries the user-typed name (the trigger may
      // have only seen the email if metadata was missing) and mark inactive.
      await sb.from('profiles').update({
        full_name: fullName || data.user.email,
        is_active: false,
      }).eq('id', data.user.id);
    } catch (profileErr) {
      console.warn('Could not flag profile pending:', profileErr);
    }
    // Sign back out so the user can't access the app until approved.
    await sb.auth.signOut();
  }
  return data;
}

// ---- Forgot password: send a one-time login link ----
export async function sendPasswordReset(email) {
  const sb = getSupabase();
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname + '#login',
  });
  if (error) throw new Error(error.message);
}

// ---- Sign Out ----
export async function signOut() {
  const sb = getSupabase();
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
