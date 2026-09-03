// ============================================================
// Patient Navigator: Main App Controller
// ============================================================

import { initAuth, getCurrentUser, getCurrentProfile, getUserRole, signIn, isImpersonating, stopImpersonation } from './auth.js';
import { registerRoute, initRouter, navigate, setAuthGuard, setRoleGuard } from './router.js';
import { renderSidebar, bindSidebarSync } from './components/sidebar.js';
import { showToast } from './components/toast.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderPatients } from './pages/patients.js';
import { renderCalls } from './pages/calls.js';
import { renderAdmin } from './pages/admin.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderCalling } from './pages/calling.js';
import { renderTeam } from './pages/team.js';
import { renderProfile } from './pages/profile.js';
import { renderLearn } from './pages/learn.js';
import { renderUpload } from './pages/upload.js';
import { renderIntake } from './pages/intake.js';
import { renderNutrition } from './pages/nutrition.js';
import { renderLeaderboard } from './pages/leaderboard.js';
import { renderConcerns } from './pages/concerns.js';
import { renderBrief } from './pages/brief.js';
import { renderSessions } from './pages/sessions.js';
import { renderResources } from './pages/resources.js';
import { renderExports } from './pages/exports.js';
import { renderReport } from './pages/report.js';
import { validateEmail, validatePassword } from './utils/validators.js';
import { CONFIG } from './config.js';
import { initTheme, renderThemeSwitch } from './theme.js';
import { initPwa, mountInstallButton } from './pwa.js';
import './components/anim.js';  // premium motion engine (window.AnimKit)

initTheme();  // apply saved light/dark/colorful before the shell renders
initPwa();    // register the service worker + offer "Add to Home Screen"

// A clear banner the moment the device drops offline, so a connection problem
// reads as "you're offline" instead of a cryptic "could not save" (or silence).
(function connectionMonitor() {
  const show = (offline) => {
    let b = document.getElementById('conn-banner');
    if (!offline) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement('div');
    b.id = 'conn-banner';
    b.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:9998;background:#BE463B;color:#fff;text-align:center;font:600 13px/1.45 system-ui,sans-serif;padding:9px 14px;box-shadow:0 2px 8px rgba(0,0,0,.2)');
    b.textContent = "You appear to be offline - the app can't reach the server. Check your internet, turn off any VPN, or try another network.";
    document.body.appendChild(b);
  };
  window.addEventListener('offline', () => show(true));
  window.addEventListener('online', () => show(false));
  if (!navigator.onLine) show(true);
})();

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
      <div class="login-split">
        <aside class="login-hero">
          <div class="lh-brand">
            <div class="logo-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            </div>
            <div>
              <div class="lh-word">Jarurat Care</div>
              <div class="lh-tag">Patient Navigator</div>
            </div>
          </div>
          <div class="lh-statement">
            <p class="lh-eyebrow">Cancer care, delivered by phone</p>
            <h1>The right call, at the <em>right time</em>.</h1>
            <p class="lh-sub">Free, human support for families facing cancer, one conversation at a time.</p>
          </div>
          <div class="lh-foot">
            <svg class="lh-ecg" viewBox="0 0 280 40" fill="none" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 20 H92 L104 20 112 7 122 33 130 20 H188 L196 20 202 12 208 27 214 20 H280" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="lh-mono">DPDPA-compliant · Consent-first · Made with care</span>
          </div>
        </aside>
        <div class="login-card">
          <div class="card">
            <div class="lc-head">
              <div class="lc-kicker">Team access</div>
              <h2>Welcome back.</h2>
              <p>Sign in to reach the people waiting to hear from us today.</p>
            </div>
            <div class="login-tabs" id="auth-tabs">
              <button class="tab active" data-tab="login">Sign In</button>
              <button class="tab" data-tab="signup">Sign Up</button>
            </div>

            <form id="login-form">
              <div class="form-group" id="email-group">
                <label class="form-label">Email</label>
                <input class="form-input" id="auth-email" type="email" placeholder="you@carcinome.org" required />
              </div>
              <div class="form-group" id="password-group">
                <label class="form-label">Password</label>
                <input class="form-input" id="auth-password" type="password" placeholder="••••••••" autocomplete="current-password" />
                <a href="#" id="forgot-password-link" style="font-size:var(--font-xs);margin-top:4px;align-self:flex-end">Forgot password?</a>
              </div>
              <div class="form-group hidden" id="auth-disabled-note">
                <div class="consent-banner" style="margin:0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                  <p style="margin:0" id="auth-disabled-copy"></p>
                </div>
              </div>
              <button type="submit" class="btn btn-primary btn-lg" style="width:100%" id="auth-submit-btn">Sign In</button>
            </form>
            <p style="text-align:center;margin-top:var(--space-4);font-size:var(--font-xs);color:var(--color-text-muted)">
              New accounts are created manually by admins only.
            </p>
            <!-- Installing before signing in is the common case on a new
                 phone, so the button is offered here too. It renders nothing
                 inside the already-installed app. -->
            <div id="pwa-install-slot-login" style="margin-top:var(--space-3)"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  mountInstallButton(document.getElementById('pwa-install-slot-login'));

  // Auth modes:
  //   'login':            email + password
  //   'signup-disabled':  signup is visible but disabled
  //   'forgot-disabled':  reset is visible but disabled
  let mode = 'login';
  const signupDisabledMessage = 'Sign up is currently disabled. Only admins can add new users manually as of now.';
  const resetDisabledMessage = 'Password reset is currently disabled. Only an admin can reset it.';

  function applyMode() {
    // After a successful sign-in the app shell replaces the login DOM, but the
    // submit handler's `finally` still calls applyMode(), bail if the form is gone.
    const emailGroup = document.getElementById('email-group');
    if (!emailGroup) return;
    const isLogin = mode === 'login';
    const isSignupDisabled = mode === 'signup-disabled';
    const disabledNote = document.getElementById('auth-disabled-note');
    const disabledCopy = document.getElementById('auth-disabled-copy');
    const btn = document.getElementById('auth-submit-btn');

    emailGroup.classList.toggle('hidden', !isLogin);
    document.getElementById('password-group').classList.toggle('hidden', !isLogin);
    disabledNote.classList.toggle('hidden', isLogin);
    if (disabledCopy) {
      disabledCopy.textContent = isSignupDisabled ? signupDisabledMessage : resetDisabledMessage;
    }
    btn.textContent =
      isLogin ? 'Sign In' :
      isSignupDisabled ? 'Sign up disabled' :
                         'Password reset disabled';
    btn.disabled = !isLogin;
    document.querySelectorAll('#auth-tabs .tab').forEach(t => {
      t.classList.toggle('active', (t.dataset.tab === 'signup' && isSignupDisabled) || (t.dataset.tab === 'login' && !isSignupDisabled));
    });
  }

  // Tab switching resets mode appropriately.
  document.querySelectorAll('#auth-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      mode = tab.dataset.tab === 'signup' ? 'signup-disabled' : 'login';
      applyMode();
    });
  });

  // Forgot password link
  document.getElementById('forgot-password-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    mode = 'forgot-disabled';
    applyMode();
  });

  applyMode();

  // Form submit
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const btn = document.getElementById('auth-submit-btn');

    if (mode === 'signup-disabled') { showToast(signupDisabledMessage, 'info'); return; }
    if (mode === 'forgot-disabled') { showToast(resetDisabledMessage, 'info'); return; }
    if (!validateEmail(email)) { showToast('Please enter a valid email', 'warning'); return; }

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      if (mode === 'login') {
        await signIn(email, password);
        // Deactivated / not-yet-approved accounts get a clear message
        // instead of an empty, RLS-blocked app.
        const prof = getCurrentProfile();
        if (prof && prof.is_active === false) {
          const { signOut } = await import('./auth.js');
          await signOut();
          throw new Error('Your account is awaiting admin approval. Please contact your administrator.');
        }
        console.log('[auth] signIn OK; mounting app shell');
        showToast('Welcome back!', 'success');
        // Mount the app shell inline (or the set-password gate).
        gateAndBoot();
        navigate(homeRoute());
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
        ${isImpersonating() ? `<div class="imp-banner">Viewing as <strong>${getCurrentProfile()?.full_name || 'user'}</strong> · ${getCurrentProfile()?.role || ''}<button id="imp-exit" type="button">Exit to your account</button></div>` : ''}
        <header class="header">
          <div class="header-left">
            <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
            </button>
          </div>
          <div class="header-right">
            <span id="theme-switch-slot"></span>
            <button class="btn btn-ghost btn-sm" id="header-profile-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span class="hide-mobile">Profile</span>
            </button>
          </div>
        </header>
        <div class="page-content" id="page-content"></div>
      </main>
      <nav class="bottom-nav" id="bottom-nav" aria-label="Primary"></nav>
    </div>
  `;

  renderSidebar();

  // Theme switch (light · dark · colorful): lives in the header, everywhere.
  const themeSlot = document.getElementById('theme-switch-slot');
  if (themeSlot) themeSlot.appendChild(renderThemeSwitch());

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

  // Exit "open as user" (master access) impersonation → reload as the real account.
  document.getElementById('imp-exit')?.addEventListener('click', () => { stopImpersonation(); location.reload(); });

  // Sidebar/bottom-nav active state self-syncs from location.hash,
  // a single module-level listener, registered once.
  bindSidebarSync();
}

// ---- First-login password gate ----
// Every new account starts on the org default password with
// profiles.must_change_password = true. Until they set their own,
// the only screen they see is this one.
function gateAndBoot() {
  const prof = getCurrentProfile();
  // A session without a profile must never mount the shell: with a null role
  // the sidebar filters to zero items, every page errors, and there is no
  // sign-out anywhere, the exact "stranded on my phone" bug. Give the user
  // a clear way out instead.
  if (!prof) { renderAccountProblemScreen(); return; }
  if (prof.must_change_password) renderPasswordChangeScreen();
  else bootApp();
}

// ---- Stranded-session recovery screen ----
// Shown when we have an auth session but couldn't load its profile
// (flaky network, or an account that was removed). Both exits are safe.
function renderAccountProblemScreen() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
          </div>
          <h1>We couldn't load your account</h1>
          <p>This is usually a weak connection, or a sign-in that is no longer valid on this device.</p>
        </div>
        <div class="card">
          <button class="btn btn-primary btn-lg" style="width:100%" id="acct-retry">Try again</button>
          <button class="btn btn-secondary btn-lg" style="width:100%;margin-top:var(--space-3)" id="acct-signout">Sign out &amp; sign in again</button>
          <p style="text-align:center;margin-top:var(--space-4);font-size:var(--font-xs);color:var(--color-text-muted)">
            If this keeps happening, ask your administrator to check your account.
          </p>
        </div>
      </div>
    </div>`;
  document.getElementById('acct-retry')?.addEventListener('click', () => location.reload());
  document.getElementById('acct-signout')?.addEventListener('click', async () => {
    const btn = document.getElementById('acct-signout');
    btn.disabled = true; btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    const { clearSession } = await import('./auth.js');
    await clearSession();          // never throws: guarantees local teardown
    appBooted = false;
    renderLoginPage();
  });
}

function renderPasswordChangeScreen() {
  const app = document.getElementById('app');
  const prof = getCurrentProfile();
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h1>Welcome, ${prof?.full_name?.split(' ')[0] || 'there'}</h1>
          <p>Set your own password to start. Only you will know it.</p>
        </div>
        <div class="card">
          <form id="setpw-form">
            <div class="form-group">
              <label class="form-label">New password</label>
              <input class="form-input" id="setpw-new" type="password" autocomplete="new-password" placeholder="••••••••" />
              <span class="form-hint">Min 8 characters with an uppercase letter, a number and a symbol.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Repeat new password</label>
              <input class="form-input" id="setpw-confirm" type="password" autocomplete="new-password" placeholder="••••••••" />
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%" id="setpw-submit">Set password &amp; continue</button>
          </form>
          <p style="text-align:center;margin-top:var(--space-4);font-size:var(--font-xs);color:var(--color-text-muted)">
            Forgot it later? An admin can reset it for you.
          </p>
        </div>
      </div>
    </div>
  `;
  document.getElementById('setpw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('setpw-new').value;
    const pw2 = document.getElementById('setpw-confirm').value;
    const err = validatePassword(pw);
    if (err) { showToast(err, 'warning'); return; }
    if (pw !== pw2) { showToast('Passwords do not match', 'warning'); return; }
    if (pw === 'Carc!nome@2026') { showToast('Please pick your own password, not the shared default', 'warning'); return; }
    const btn = document.getElementById('setpw-submit');
    btn.disabled = true; btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const { getSupabase } = await import('./supabase.js');
      const sb = getSupabase();
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) throw new Error(error.message);
      await sb.rpc('clear_password_flag');
      const prof2 = getCurrentProfile();
      if (prof2) prof2.must_change_password = false;
      showToast('Password set. Welcome aboard!', 'success');
      bootApp();
      navigate(homeRoute());
    } catch (err2) {
      showToast('Could not set password: ' + err2.message, 'error');
      btn.disabled = false; btn.textContent = 'Set password & continue';
    }
  });
}

// ---- Role-aware landing page ----
// Managers/admins run the daily assign-and-monitor flow → Team & Queue.
// Callers land on their worklist, uploaders on intake; everyone else home.
function homeRoute() {
  switch (getUserRole()) {
    case 'admin':
    case 'manager':           return 'team';
    case 'caller':
    case 'caregiver_mentor':  return 'calling';
    case 'uploader':
    case 'ground_poc':        return 'upload';
    default:                  return 'dashboard';
  }
}

// ---- Post-noon auto-assign fallback ----
// pg_cron isn't enabled on this project, so the noon (12:00 IST) build can't
// run purely server-side. When a manager/admin opens the app after the noon
// cutoff and today's list hasn't been built yet, build it once. The RPC is
// idempotent and only rotates UNSTARTED work of absent callers, so this never
// churns an existing, in-progress distribution.
async function maybeAutoBuild() {
  const role = getUserRole();
  if (role !== 'admin' && role !== 'manager') return;
  // 12:00 IST = 06:30 UTC. Only after the cutoff, once per day per session.
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() + nowUtc.getUTCMinutes() / 60 < 6.5) return;
  const istDay = new Date(nowUtc.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  if (sessionStorage.getItem('autobuild_' + istDay)) return;
  sessionStorage.setItem('autobuild_' + istDay, '1');
  try {
    const { getSupabase } = await import('./supabase.js');
    const sb = getSupabase();
    const { count } = await sb.from('call_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    if (count && count > 0) return;  // someone already built today's list
    const { data } = await sb.rpc('build_daily_assignments');
    if (data && !data.error && (data.follow_ups || data.new_leads)) {
      showToast(`Today's list is ready, ${data.follow_ups} follow-ups + ${data.new_leads} new across ${data.available_callers} caregiver mentors`, 'success');
    }
  } catch (e) { console.warn('[autobuild] skipped:', e.message); }
}

// ---- Boot app shell and router ----
const APP_BUILD = '20260903a';  // bumped on every breaking deploy
let appBooted = false;
const INTAKE_ROLES = ['ground_poc', 'uploader'];
const CARE_ROLES = ['admin', 'manager', 'caller', 'caregiver_mentor', 'therapist', 'nutritionist', 'content'];
const UPLOAD_ROLES = ['admin', 'manager', 'content', ...INTAKE_ROLES];

function bootApp() {
  console.log('[boot] bootApp called, appBooted=' + appBooted + ', hash=' + window.location.hash);
  if (appBooted) {
    console.log('[boot] already booted: skip');
    return;
  }
  appBooted = true;
  // Set the target hash BEFORE mounting the shell so the router's first
  // read doesn't trigger the login handler (which would overwrite the shell).
  const hash = window.location.hash.slice(1);
  const isIntakeRole = INTAKE_ROLES.includes(getUserRole());
  if (!hash || hash === 'login' || (isIntakeRole && ['calling', 'calls', 'learn'].includes(hash.split('/')[0]))) {
    history.replaceState(null, '', '#' + homeRoute());
  }
  try {
    renderAppShell();
    console.log('[boot] app shell mounted');
    initRouter();
    console.log('[boot] router initialized');
    maybeAutoBuild();
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
  // The morning brief. Same roles as the calling portal, because it is the
  // thing you read on the way into it.
  registerRoute('brief', (c) => renderBrief(c), { requiresAuth: true, roles: CARE_ROLES });
  registerRoute('patients', (c, p) => renderPatients(c, p), { requiresAuth: true });
  registerRoute('calls', (c) => renderCalls(c), { requiresAuth: true, roles: CARE_ROLES });
  registerRoute('admin', (c, p) => renderAdmin(c, p), { requiresAuth: true, roles: ['admin', 'manager'] });
  registerRoute('analytics', (c) => renderAnalytics(c), { requiresAuth: true, roles: ['admin', 'manager', 'content'] });
  registerRoute('calling', (c) => renderCalling(c), { requiresAuth: true, roles: CARE_ROLES });
  registerRoute('team', (c) => renderTeam(c), { requiresAuth: true, roles: ['admin', 'manager'] });
  registerRoute('profile', (c) => renderProfile(c), { requiresAuth: true });
  registerRoute('learn', (c) => renderLearn(c), { requiresAuth: true, roles: CARE_ROLES });
  registerRoute('upload', (c) => renderUpload(c), { requiresAuth: true, roles: UPLOAD_ROLES });
  registerRoute('intake', (c) => renderIntake(c), { requiresAuth: true, roles: UPLOAD_ROLES });
  registerRoute('nutrition', (c) => renderNutrition(c), { requiresAuth: true, roles: ['nutritionist', 'manager', 'admin'] });
  registerRoute('leaderboard', (c) => renderLeaderboard(c), { requiresAuth: true, roles: ['admin', 'manager'] });
  // Concerns: managers triage; calling roles can follow the flags they raised.
  registerRoute('concerns', (c) => renderConcerns(c), { requiresAuth: true, roles: CARE_ROLES });
  // Mentors can hold well-being/caregiver 1:1s themselves, so they get the pipeline too.
  registerRoute('sessions', (c) => renderSessions(c), { requiresAuth: true, roles: ['therapist', 'nutritionist', 'manager', 'admin', 'caller', 'caregiver_mentor'] });
  registerRoute('resources', (c) => renderResources(c), { requiresAuth: true });
  // Data room: raw CSV downloads. Managers/admins get everything,
  // content (research) only the de-identified datasets.
  registerRoute('exports', (c) => renderExports(c), { requiresAuth: true, roles: ['admin', 'manager', 'content'] });
  registerRoute('report', (c) => renderReport(c), { requiresAuth: true, roles: ['admin', 'manager'] });

  // Set guards
  setAuthGuard(() => !!getCurrentUser());
  setRoleGuard((roles) => roles.includes(getUserRole()));

  // Listen for sign out to go back to login.
  // Also handle SIGNED_IN events that didn't come from our login form
  // (e.g., magic-link, OTP, oauth redirects) so the app boots correctly.
  // IMPORTANT: supabase-js holds an internal auth lock while these
  // callbacks run. Calling getSession()/queries synchronously inside
  // deadlocks the whole client (boot screen forever after a reload).
  // Defer ALL work to the next tick so the lock is released first.
  const { getSupabase } = await import('./supabase.js');
  getSupabase().auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (event === 'SIGNED_OUT') {
        appBooted = false;
        renderLoginPage();
      } else if (event === 'SIGNED_IN' && session && !appBooted) {
        // Wait for BOTH user and profile. Booting before the profile
        // loads renders role-gated pages wrong for a moment.
        if (!getCurrentUser() || !getCurrentProfile()) {
          const s = await initAuth();
          // initAuth tears down sessions with no usable profile, respect that.
          if (!s) { renderLoginPage(); return; }
        }
        gateAndBoot();
      }
    }, 0);
  });

  // Check for existing session
  console.log('[init] checking existing session…');
  const session = await initAuth();
  console.log('[init] session?', !!session);
  if (session) {
    gateAndBoot();
  } else {
    renderLoginPage();
  }
}

// Start the app, wrap in try/catch so a startup error never leaves the boot spinner up.
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
