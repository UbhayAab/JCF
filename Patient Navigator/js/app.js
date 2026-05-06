// ============================================================
// Patient Navigator — Main App Controller
// ============================================================

import { initAuth, getCurrentUser, getCurrentProfile, getUserRole, signIn, signUp } from './auth.js';
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
            <div class="form-group">
              <label class="form-label">Password</label>
              <input class="form-input" id="auth-password" type="password" placeholder="••••••••" required />
            </div>
            <div class="form-group hidden" id="signup-name-group">
              <label class="form-label">Full Name</label>
              <input class="form-input" id="auth-name" placeholder="Your full name" />
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%" id="auth-submit-btn">Sign In</button>
          </form>
          <p style="text-align:center;margin-top:var(--space-4);font-size:var(--font-xs);color:var(--color-text-muted)">
            New accounts default to Caller role. Admin approval required for elevated access.
          </p>
        </div>
      </div>
    </div>
  `;

  let isSignup = false;

  // Tab switching
  document.querySelectorAll('#auth-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#auth-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      isSignup = tab.dataset.tab === 'signup';
      document.getElementById('signup-name-group').classList.toggle('hidden', !isSignup);
      document.getElementById('auth-submit-btn').textContent = isSignup ? 'Create Account' : 'Sign In';
    });
  });

  // Form submit
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const name = document.getElementById('auth-name').value.trim();
    const btn = document.getElementById('auth-submit-btn');

    if (!validateEmail(email)) { showToast('Please enter a valid email', 'warning'); return; }

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      if (isSignup) {
        if (!name) { showToast('Name is required', 'warning'); btn.disabled = false; btn.textContent = 'Create Account'; return; }
        const pwErr = validatePassword(password);
        if (pwErr) { showToast(pwErr, 'warning'); btn.disabled = false; btn.textContent = 'Create Account'; return; }
        await signUp(email, password, name);
        showToast('Account created! You can now sign in.', 'success');
        document.querySelector('#auth-tabs .tab[data-tab="login"]').click();
      } else {
        await signIn(email, password);
        showToast('Welcome back!', 'success');
        // After sign-in, boot the app shell
        bootApp();
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = isSignup ? 'Create Account' : 'Sign In';
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
            <button class="mobile-menu-btn" id="mobile-menu-btn">
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
}

// ---- Boot app shell and router ----
function bootApp() {
  renderAppShell();
  initRouter();
  // If no hash or on login hash, go to dashboard
  const hash = window.location.hash.slice(1);
  if (!hash || hash === 'login') {
    navigate('dashboard');
  }
}

// ---- Initialize App ----
async function init() {
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

  // Listen for sign out to go back to login
  const { getSupabase } = await import('./supabase.js');
  getSupabase().auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      renderLoginPage();
    }
  });

  // Check for existing session
  const session = await initAuth();
  if (session) {
    bootApp();
  } else {
    renderLoginPage();
  }
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
