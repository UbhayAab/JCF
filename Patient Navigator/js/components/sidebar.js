// ============================================================
// Patient Navigator: Sidebar + bottom nav
// Active state is computed from location.hash at render time,
// NOT from the router's cached route, which lags one navigation
// behind (the old "wrong button highlighted" bug).
// ============================================================

import { getCurrentProfile, getUserRole, signOut } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { getSupabase } from '../supabase.js';
import { navigate } from '../router.js';
import { showToast } from './toast.js';
import { confirmModal, showModal, closeModal } from './modal.js';
import { probationLevel, routeOpen, progressLine, ensureProbation, unlockNews } from '../utils/probation.js';
import { icon } from './icons.js';
import { roleLabel } from '../utils/formatters.js';
import { mountInstallButton } from '../pwa.js';
import { mountFreshStart } from '../freshstart.js';
import { AVATAR_COLORS, avatarColor, initials } from '../utils/avatar.js';

const CARE_ROLES = ['admin', 'manager', 'caller', 'caregiver_mentor', 'therapist', 'nutritionist', 'content'];
const INTAKE_ROLES = ['ground_poc', 'uploader'];
const ALL_ROLES = [...CARE_ROLES, ...INTAKE_ROLES];
const UPLOAD_ROLES = ['admin', 'manager', 'content', ...INTAKE_ROLES];

const NAV_ITEMS = [
  {
    section: 'Main',
    items: [
      { id: 'brief',     label: 'This morning',   icon: 'sun',       route: 'brief',     roles: ['admin', 'manager', 'caller', 'caregiver_mentor', 'therapist'] },
      { id: 'dashboard', label: 'Dashboard',      icon: 'grid',      route: 'dashboard', roles: ALL_ROLES },
      { id: 'calling',   label: 'Calling Portal', icon: 'phoneCall', route: 'calling',   roles: ['admin', 'manager', 'caller', 'caregiver_mentor', 'therapist', 'content'] },
      { id: 'nutrition', label: 'Nutrition',      icon: 'leaf',      route: 'nutrition', roles: ['nutritionist', 'manager', 'admin'] },
      { id: 'sessions',  label: '1:1 Sessions',   icon: 'calendar',  route: 'sessions',  roles: ['therapist', 'nutritionist', 'manager', 'admin', 'caller', 'caregiver_mentor'] },
      { id: 'patients',  label: 'Patients',       icon: 'users',     route: 'patients',  roles: ALL_ROLES },
      { id: 'calls',     label: 'Call Logs',      icon: 'phone',     route: 'calls',     roles: CARE_ROLES },
      // Moved out of Management, 2026-09-10. The route has been open to every
      // care role since app.js:515, but the only nav link was under a heading
      // admins and managers see and interns do not, so a mentor who raised a
      // flag had nowhere to find out what happened to it, and one looking for
      // a way to escalate had nowhere to look. Reported 01/09 by Prachi as
      // "there does not appear to be a clear option for interns to flag such
      // cases". Zero reassignment requests have ever been made.
      { id: 'concerns',  label: 'Flags & concerns', icon: 'alertTriangle', route: 'concerns', roles: CARE_ROLES },
      { id: 'leads',     label: 'WhatsApp leads', icon: 'inbox', route: 'leads', roles: CARE_ROLES.filter((r) => r !== 'content') },
      // Fixboard #24: write one message, pick who and when; HopeBot sends it (sql/168).
      { id: 'broadcasts', label: 'WhatsApp messages', icon: 'message', route: 'broadcasts', roles: ['admin', 'manager'] },
      { id: 'docreads',  label: 'Document reads', icon: 'fileText', route: 'docreads', roles: ['admin', 'manager'] },
      { id: 'resources', label: 'Resources',      icon: 'mapPin',    route: 'resources', roles: ALL_ROLES },
      { id: 'upload',    label: 'Upload leads & docs', icon: 'upload', route: 'upload',  roles: UPLOAD_ROLES },
      { id: 'intake',    label: 'Intake report',  icon: 'fileText',  route: 'intake',    roles: UPLOAD_ROLES },
      { id: 'analytics', label: 'Analytics',      icon: 'chart',     route: 'analytics', roles: ['admin', 'manager', 'content'] },
      { id: 'exports',   label: 'Data room',      icon: 'download',  route: 'exports',   roles: ['admin', 'manager', 'content'] },
      { id: 'learn',     label: 'Learning Hub',   icon: 'book',      route: 'learn',     roles: CARE_ROLES },
    ],
  },
  {
    section: 'Management',
    items: [
      { id: 'team',        label: 'Team & Queue',    icon: 'userPlus',    route: 'team',        roles: ['admin', 'manager'] },
      { id: 'leaderboard', label: 'Leaderboard',     icon: 'chart',       route: 'leaderboard', roles: ['admin', 'manager'] },
      // 28 Sep, Aadrika: "see which intern uploaded documents of which patients".
      { id: 'uploads',     label: 'Document uploads', icon: 'fileText',   route: 'uploads',     roles: ['admin', 'manager'] },
      { id: 'report',      label: 'Impact Report',   icon: 'fileText',    route: 'report',      roles: ['admin', 'manager'] },
      { id: 'admin-users', label: 'User Management', icon: 'shieldCheck', route: 'admin/users', roles: ['admin', 'manager'] },
      { id: 'admin-audit', label: 'Audit Log',       icon: 'fileText',    route: 'admin/audit', roles: ['admin'] },
    ],
  },
];

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// Which nav route should be highlighted for the current hash?
// '#patients/abc-123' → 'patients'; '#admin/users' → 'admin/users'.
function activeRouteFromHash() {
  // '#exports?tab=canvas&code=...' and '#patients?q=...' carry a query; match the path.
  const hash = (window.location.hash || '').slice(1).split('?')[0];
  if (!hash) return 'dashboard';
  const allRoutes = NAV_ITEMS.flatMap(s => s.items.map(i => i.route));
  if (allRoutes.includes(hash)) return hash;
  // longest registered route that prefixes the hash ('patients/…' → 'patients')
  let best = '';
  for (const r of allRoutes) {
    if ((hash === r || hash.startsWith(r + '/')) && r.length > best.length) best = r;
  }
  return best || hash.split('/')[0];
}

export function renderSidebar() {
  const profile = getCurrentProfile();
  const role = getUserRole();
  const active = activeRouteFromHash();

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const navHTML = NAV_ITEMS.map(section => {
    // On probation (Fixboard #23) only the open tabs show: hidden, not greyed out.
    const visibleItems = section.items.filter(item => item.roles.includes(role) && routeOpen(item.route, role));
    if (visibleItems.length === 0) return '';
    return `
      <div class="nav-section">
        <div class="nav-section-title">${section.section}</div>
        ${visibleItems.map(item => `
          <button class="nav-item ${active === item.route ? 'active' : ''}"
                  data-route="${item.route}" id="nav-${item.id}" aria-current="${active === item.route ? 'page' : 'false'}">
            ${icon(item.icon)}
            <span>${item.label}</span>
            ${item.id === 'concerns' ? '<span class="nav-badge" id="navcount-concerns" style="display:none"></span>' : ''}
            ${item.id === 'leads' ? '<span class="nav-badge" id="navcount-leads" style="display:none" title="Families waiting for the call HopeBot promised"></span>' : ''}
          </button>
        `).join('')}
      </div>
    `;
  }).join('');

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo">${icon('heartPulse')}</div>
      <div class="sidebar-brand">
        <span class="sidebar-brand-name">Jarurat Care</span>
        <span class="sidebar-brand-sub">Patient Navigator</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${navHTML}
    </nav>
    <div class="sidebar-footer">
      ${progressLine() ? `<div class="probation-card" id="probation-card">${icon('book')}<span>${progressLine()}</span></div>` : ''}
      <!-- Install lives here, not in a popup: present in a browser tab,
           absent once the app is installed. -->
      <div id="pwa-install-slot"></div>
      <!-- Update / Reset. Staff kept reporting bugs that were fixed days ago
           because their device was still on an older shell; "clear your cache"
           is five screens deep on Android Chrome and impossible inside the
           installed app. See js/freshstart.js. -->
      <div id="freshstart-slot"></div>
      <div class="sidebar-user">
        <button class="sidebar-user-main ${active === 'profile' ? 'active' : ''}" id="sidebar-profile-btn" title="My profile">
          <div class="avatar" style="background: ${avatarColor(profile?.full_name)}">${sanitize(getInitials(profile?.full_name))}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name">${sanitize(profile?.full_name) || 'User'}</div>
            <div class="sidebar-user-role">${role ? roleLabel(role) : ''}</div>
          </div>
        </button>
        <button class="sidebar-logout-btn" id="sidebar-logout-btn" title="Sign out" aria-label="Sign out">${icon('logOut')}</button>
      </div>
    </div>
  `;

  mountInstallButton(sidebar.querySelector('#pwa-install-slot'));
  mountFreshStart(sidebar.querySelector('#freshstart-slot'));

  sidebar.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.route);
      sidebar.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('active');
    });
  });

  // Profile block opens the profile page; signing out is its OWN button
  // and asks first. One mis-tap used to log people straight out.
  document.getElementById('sidebar-profile-btn')?.addEventListener('click', () => {
    navigate('profile');
    sidebar.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
  });
  document.getElementById('sidebar-logout-btn')?.addEventListener('click', () => {
    confirmModal('Sign out of Patient Navigator?', async () => {
      try {
        await signOut();
        navigate('login');
        showToast('Signed out', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    }, { title: 'Sign out', confirmLabel: 'Sign out', danger: false });
  });

  renderBottomNav(role, active);
  refreshConcernCount();
  refreshHopebotCount();

  // On probation: count the calls (at most once a minute), redraw when a step
  // opens, and say once what each new tab is for.
  ensureProbation().then((changed) => {
    if (changed && document.getElementById('sidebar')) { renderSidebar(); return; }
    showUnlockNews();
  });
}

function showUnlockNews() {
  const news = unlockNews();
  if (!news) return;
  const learn = '<a href="#learn" class="unlock-learn">Learning Hub</a>';
  const content = news === 'all'
    ? `<p style="margin:0 0 10px">You have finished training: every tab of your role is in the menu now.</p>
       <p class="due-meta" style="margin:0">Not sure what a tab is for? The ${learn} explains each one.</p>`
    : `<p style="margin:0 0 10px">After your first conversations, three more tabs are in the menu:</p>
       <ul style="margin:0 0 10px;padding-left:18px">${news.map(n => `<li><strong>${n.label}</strong>: ${n.what}.</li>`).join('')}</ul>
       <p class="due-meta" style="margin:0">The ${learn} has a page on each.</p>`;
  showModal({
    title: news === 'all' ? 'Every tab is open' : 'New tabs are open',
    content,
    footer: '<button type="button" class="btn btn-primary" id="unlock-ok">Got it</button>',
  });
  document.getElementById('unlock-ok')?.addEventListener('click', () => closeModal());
  document.querySelectorAll('.unlock-learn').forEach(a => a.addEventListener('click', () => closeModal()));
}

// Open-concern count pill on the Concerns nav item (managers/admins).
// Cached for a minute: the sidebar re-renders on every navigation and
// this must not become a query per click.
let concernCache = { n: 0, at: 0 };
async function refreshConcernCount() {
  if (!['admin', 'manager'].includes(getUserRole())) return;
  if (Date.now() - concernCache.at > 60000) {
    try {
      const { count } = await getSupabase().from('patient_concerns')
        .select('*', { count: 'exact', head: true })
        .in('status', ['open', 'acknowledged'])
        // care gaps have their own card on the lead dashboard
        .not('reason', 'like', 'care_gap_%');
      concernCache = { n: count || 0, at: Date.now() };
    } catch { /* leave the pill hidden on failure */ }
  }
  const el = document.getElementById('navcount-concerns');
  if (el) { el.textContent = concernCache.n; el.style.display = concernCache.n ? '' : 'none'; }
}

// Families waiting for the call HopeBot promised (sql/172), on WhatsApp leads.
// Same one-minute cache. Row security decides whose requests are counted.
const HOPEBOT_COUNT_ROLES = ['admin', 'manager', 'caller', 'caregiver_mentor', 'therapist', 'nutritionist'];
let hopebotCache = { n: 0, at: 0 };
async function refreshHopebotCount() {
  if (!HOPEBOT_COUNT_ROLES.includes(getUserRole())) return;
  if (Date.now() - hopebotCache.at > 60000) {
    try {
      const { count, error } = await getSupabase().from('hopebot_requests')
        .select('id', { count: 'exact', head: true })
        .neq('state', 'closed');
      if (!error) hopebotCache = { n: count || 0, at: Date.now() };
    } catch { /* leave the pill hidden on failure */ }
  }
  const el = document.getElementById('navcount-leads');
  if (el) { el.textContent = hopebotCache.n; el.style.display = hopebotCache.n ? '' : 'none'; }
}

// Mobile bottom-nav: 5 priority destinations.
function renderBottomNav(role, active) {
  const el = document.getElementById('bottom-nav');
  if (!el) return;

  const isManagerOrAdminRole = ['admin', 'manager'].includes(role);
  const isIntakeRole = INTAKE_ROLES.includes(role);
  const isNutritionist = role === 'nutritionist';
  const items = isNutritionist
    ? [
        { id: 'dashboard', label: 'Home',      route: 'dashboard', icon: 'grid' },
        { id: 'nutrition', label: 'Nutrition', route: 'nutrition', icon: 'leaf' },
        { id: 'patients',  label: 'Patients',  route: 'patients',  icon: 'users' },
        { id: 'profile',   label: 'Profile',   route: 'profile',   icon: 'user' },
      ]
    : isIntakeRole
    ? [
        { id: 'dashboard', label: 'Home',     route: 'dashboard', icon: 'grid' },
        { id: 'upload',    label: 'Upload',   route: 'upload',    icon: 'upload' },
        { id: 'patients',  label: 'My leads', route: 'patients',  icon: 'users' },
        { id: 'profile',   label: 'Profile',  route: 'profile',   icon: 'user' },
      ]
    : [
        { id: 'dashboard', label: 'Home',     route: 'dashboard', icon: 'grid' },
        { id: 'calling',   label: 'Call',     route: 'calling',   icon: 'phoneCall' },
        { id: 'patients',  label: 'Patients', route: 'patients',  icon: 'users' },
        { id: 'calls',     label: 'Logs',     route: 'calls',     icon: 'phone' },
        isManagerOrAdminRole
          ? { id: 'team',    label: 'Team',    route: 'team',    icon: 'userPlus' }
          : { id: 'profile', label: 'Profile', route: 'profile', icon: 'user' },
      ];

  // On probation (Fixboard #23): only open tabs, and the Learning Hub in reach.
  let shown = items.filter(it => routeOpen(it.route, role));
  if (probationLevel() !== 'all' && !shown.some(it => it.route === 'learn')) {
    const at = shown.findIndex(it => it.route === 'profile');
    const learn = { id: 'learn', label: 'Learn', route: 'learn', icon: 'book' };
    shown = at < 0 ? [...shown, learn] : [...shown.slice(0, at), learn, ...shown.slice(at)];
  }

  el.innerHTML = `
    <div class="bottom-nav-list">
      ${shown.map(it => `
        <button class="bottom-nav-item ${active === it.route ? 'active' : ''}" data-route="${it.route}" aria-label="${it.label}">
          ${icon(it.icon)}
          <span>${it.label}</span>
        </button>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('.bottom-nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.route));
  });
}

// Self-sync: one module-level listener; derives state from the hash,
// so it can never lag behind the router.
let syncBound = false;
export function bindSidebarSync() {
  if (syncBound) return;
  syncBound = true;
  window.addEventListener('hashchange', () => {
    if (document.getElementById('sidebar')) renderSidebar();
  });
}
