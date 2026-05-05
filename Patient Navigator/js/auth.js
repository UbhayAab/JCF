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

// ---- Initialize auth (check existing session) ----
export async function initAuth() {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) {
      console.warn('Session check failed:', error.message);
      return null;
    }
    if (session?.user) {
      currentUser = session.user;
      await loadProfile();
      return session;
    }
    return null;
  } catch (err) {
    console.warn('Session init error:', err);
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
export async function signIn(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    throw new Error(error.message);
  }

  // Check if user is active
  currentUser = data.user;
  await loadProfile();

  if (currentProfile && !currentProfile.is_active) {
    await sb.auth.signOut();
    currentUser = null;
    currentProfile = null;
    throw new Error('Your account has been deactivated. Please contact an administrator.');
  }

  return data;
}

// ---- Sign Up ----
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
