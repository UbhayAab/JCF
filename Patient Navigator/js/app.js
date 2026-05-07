// ============================================================
// Patient Navigator — Main App Controller
// ============================================================

import { initAuth, getCurrentUser, getCurrentProfile, getUserRole, signIn, signUp, sendSignupOtp, verifySignupOtp, sendPasswordReset } from './auth.js';
import { registerRoute, initRouter, navigate, setAuthGuard, setRoleGuard } from './router.js';
import { renderSidebar } from './components/sidebar.js';
import { showToast } from './components/toast.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderPatients } from './pages/patients.js';
import { renderCalls } from './pages/calls.js';
import { renderAdmin } from './pages/admin.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderCalling } from './pages/calling.js';
import { renderTeam } from './pages/team.js';
import { renderProfile } from './pages/profile.js';
import { validateEmail, validatePassword } from './utils/validators.js';
import { CONFIG } from './config.js';

// ---- Check Supabase config ----
function checkConfig() {
  if (CONFIG.SUPABASE_URL === 'YOUR_SUPABASE_URL' || CONFIG.SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
    document.getElementById('app').innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="card" style="text-align:center">
            <div class="login-logo">
              <div class="logo-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
              </div>
              <h1>Setup Required</h1>
            </div>
            <p>Please configure your Supabase credentials in <code>js/config.js</code></p>
            <p class="text-muted">You need your <strong>Project URL</strong> and <strong>Anon Key</strong> from the Supabase Dashboard → Settings → API</p>
          </div>
        </div>
      </div>
    `;
    return false;
  }
  return true;
}

// ---- Render Login Page ----
function renderLoginPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
          </div>
          <h1>Patient Navigator</h1>
          <p>Carcinome NGO — Secure Patient Data Management</p>
        </div>
        <div class="card">
          <div class="login-tabs" id="auth-tabs">
            <button class="tab active" data-tab="login">Sign In</button>
            <button class="tab" data-tab="signup">Sign Up</button>
          </div>

          <form id="login-form">
            <div class="form-group">
              <label class="form-label">Email</label>
              <input class="form-input" id="auth-email" type="email" placeholder="you@carcinome.org" required />
            </div>
            <div class="form-group" id="password-group">
              <label class="form-label">Password</label>
              <input class="form-input" id="auth-password" type="password" placeholder="••••••••" autocomplete="current-password" />
              <a href="#" id="forgot-password-link" style="font-size:var(--font-xs);margin-top:4px;align-self:flex-end">Forgot password?</a>
            </div>
            <div class="form-group hidden" id="signup-name-group">
              <label class="form-label">Full Name</label>
              <input class="form-input" id="auth-name" placeholder="Your full name" />
            </div>
            <div class="form-group hidden" id="otp-group">
              <label class="form-label">6-digit code from your email</label>
              <input class="form-input" id="auth-otp" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="000000" autocomplete="one-time-code" />
              <span class="form-hint">Check your inbox and spam folder.</span>
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%" id="auth-submit-btn">Sign In</button>
          </form>
          <p style="text-align:center;margin-top:var(--space-4);font-size:var(--font-xs);color:var(--color-text-muted)">
            New accounts must be approved by an administrator before sign-in.
          </p>
        </div>
      </div>
    </div>
  `;

  // Auth modes:
  //   'login'        — email + password
  //   'signup-step1' — email + name (sends OTP)
  //   'signup-step2' — enter OTP from email
  //   'forgot'       — email only (sends reset link)
  let mode = 'login';
  let pendingSignupEmail = null;
  let pendingSignupName = null;

  function applyMode() {
    const isSignup = mode === 'signup-step1' || mode === 'signup-step2';
    const isOtp    = mode === 'signup-step2';
    const isForgot = mode === 'forgot';
    document.getElementById('signup-name-group').classList.toggle('hidden', !isSignup || isOtp);
    document.getElementById('otp-group').classList.toggle('hidden', !isOtp);
    document.getElementById('password-group').classList.toggle('hidden', isSignup || isForgot);
    document.getElementById('auth-submit-btn').textContent =
      mode === 'login'        ? 'Sign In' :
      mode === 'signup-step1' ? 'Send verification code' :
      mode === 'signup-step2' ? 'Verify & create account' :
                                'Send reset link';
    document.querySelectorAll('#auth-tabs .tab').forEach(t => {
      t.classList.toggle('active', (t.dataset.tab === 'signup' && isSignup) || (t.dataset.tab === 'login' && !isSignup));
    });
  }

  // Tab switching resets mode appropriately.
  document.querySelectorAll('#auth-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      mode = tab.dataset.tab === 'signup' ? 'signup-step1' : 'login';
      pendingSignupEmail = null;
      pendingSignupName = null;
      applyMode();
    });
  });

  // Forgot password link
  document.getElementById('forgot-password-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    mode = 'forgot';
    applyMode();
  });

  applyMode();

  // Form submit
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const name = document.getElementById('auth-name').value.trim();
    const otp = document.getElementById('auth-otp').value.trim();
    const btn = document.getElementById('auth-submit-btn');

    if (!validateEmail(email) && mode !== 'signup-step2') { showToast('Please enter a valid email', 'warning'); return; }

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      if (mode === 'signup-step1') {
        if (!name) { throw new Error('Full name is required'); }
        await sendSignupOtp(email, name);
        pendingSignupEmail = email;
        pendingSignupName = name;
        mode = 'signup-step2';
        applyMode();
        showToast('Verification code sent. Check your email.', 'success');
      } else if (mode === 'signup-step2') {
        if (!/^\d{6}$/.test(otp)) { throw new Error('Enter the 6-digit code from your email'); }
        await verifySignupOtp(pendingSignupEmail || email, otp, pendingSignupName);
        showToast('Account created. An admin must approve before you can sign in.', 'success');
        // Reset to login mode
        mode = 'login';
        pendingSignupEmail = null;
        pendingSignupName = null;
        document.getElementById('auth-otp').value = '';
        applyMode();
      } else if (mode === 'forgot') {
        await sendPasswordReset(email);
        showToast('Password-reset link sent. Check your email.', 'success');
        mode = 'login';
        applyMode();
      } else {
        // login
        await signIn(email, password);
        console.log('[auth] signIn OK; mounting app shell');
        showToast('Welcome back!', 'success');
        // Mount the app shell inline.
        bootApp();
        navigate('dashboard');
      }
    } catch (err) {
      console.error('[auth] form error:', err);
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      applyMode();  // restores the correct button label
    }
  });
}

// ---- Render App Shell ----
function renderAppShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <div class="sidebar-overlay" id="sidebar-overlay"></div>
      <aside class="sidebar" id="sidebar"></aside>
      <main class="main-content">
        <header class="header">
          <div class="header-left">
            <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
            </button>
          </div>
          <div class="header-right">
            <button class="btn btn-ghost btn-sm" id="header-profile-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Profile
            </button>
          </div>
        </header>
        <div class="page-content" id="page-content"></div>
      </main>
      <nav class="bottom-nav" id="bottom-nav" aria-label="Primary"></nav>
    </div>
  `;

  renderSidebar();

  // Mobile menu
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('active');
  });
  document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('active');
  });

  // Profile button
  document.getElementById('header-profile-btn')?.addEventListener('click', () => navigate('profile'));

  // Keep the sidebar + bottom-nav active state in sync with the current route.
  window.addEventListener('hashchange', () => renderSidebar());
}

// ---- Boot app shell and router ----
const APP_BUILD = '20260507e';  // bumped on every breaking deploy
let appBooted = false;
function bootApp() {
  console.log('[boot] bootApp called, appBooted=' + appBooted + ', hash=' + window.location.hash);
  if (appBooted) {
    console.log('[boot] already booted — skip');
    return;
  }
  appBooted = true;
  // Set the target hash BEFORE mounting the shell so the router's first
  // read doesn't trigger the login handler (which would overwrite the shell).
  const hash = window.location.hash.slice(1);
  if (!hash || hash === 'login') {
    history.replaceState(null, '', '#dashboard');
  }
  try {
    renderAppShell();
    console.log('[boot] app shell mounted');
    initRouter();
    console.log('[boot] router initialized');
  } catch (e) {
    console.error('[boot] FAILED to render shell:', e);
    appBooted = false;
    document.getElementById('app').innerHTML =
      '<div class="boot-screen"><p class="boot-msg boot-error">Boot error: ' +
      (e && e.message ? e.message : 'unknown') +
      '</p><button class="boot-link" onclick="location.reload()">Reload</button></div>';
  }
}

// ---- Initialize App ----
async function init() {
  console.log('[init] starting Patient Navigator build ' + APP_BUILD);
  if (!checkConfig()) return;

  // Register routes
  registerRoute('login', () => renderLoginPage(), { requiresAuth: false });
  registerRoute('dashboard', (c) => renderDashboard(c), { requiresAuth: true });
  registerRoute('patients', (c, p) => renderPatients(c, p), { requiresAuth: true });
  registerRoute('calls', (c) => renderCalls(c), { requiresAuth: true });
  registerRoute('admin', (c, p) => renderAdmin(c, p), { requiresAuth: true, roles: ['admin'] });
  registerRoute('analytics', (c) => renderAnalytics(c), { requiresAuth: true, roles: ['admin', 'manager', 'content'] });
  registerRoute('calling', (c) => renderCalling(c), { requiresAuth: true });
  registerRoute('team', (c) => renderTeam(c), { requiresAuth: true, roles: ['admin', 'manager'] });
  registerRoute('profile', (c) => renderProfile(c), { requiresAuth: true });

  // Set guards
  setAuthGuard(() => !!getCurrentUser());
  setRoleGuard((roles) => roles.includes(getUserRole()));

  // Listen for sign out to go back to login.
  // Also handle SIGNED_IN events that didn't come from our login form
  // (e.g., magic-link, OTP, oauth redirects) so the app boots correctly.
  const { getSupabase } = await import('./supabase.js');
  getSupabase().auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      appBooted = false;
      renderLoginPage();
    } else if (event === 'SIGNED_IN' && session && !appBooted) {
      if (!getCurrentUser()) {
        await initAuth();
      }
      bootApp();
    }
  });

  // Check for existing session
  console.log('[init] checking existing session…');
  const session = await initAuth();
  console.log('[init] session?', !!session);
  if (session) {
    bootApp();
  } else {
    renderLoginPage();
  }
}

// Start the app — wrap in try/catch so a startup error never leaves the boot spinner up.
document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('App init failed:', err);
    try { renderLoginPage(); }
    catch (_) {
      document.getElementById('app').innerHTML =
        '<div class="boot-screen"><p style="color:#ef4444">Failed to start: ' +
        (err && err.message ? err.message : 'unknown error') +
        '</p><a href="#" onclick="location.reload()" style="color:#22d3ee">Reload</a></div>';
    }
  });
});
