// ============================================================
// Patient Navigator: Sidebar + bottom nav
// Active state is computed from location.hash at render time,
// NOT from the router's cached route, which lags one navigation
// behind (the old "wrong button highlighted" bug).
// ============================================================

import { getCurrentProfile, getUserRole, signOut } from '../auth.js';
import { getSupabase } from '../supabase.js';
import { navigate } from '../router.js';
import { showToast } from './toast.js';
import { confirmModal } from './modal.js';
import { icon } from './icons.js';
import { roleLabel } from '../utils/formatters.js';
import { mountInstallButton } from '../pwa.js';
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
      { id: 'resources', label: 'Resources',      icon: 'mapPin',    route: 'resources', roles: ALL_ROLES },
      { id: 'upload',    label: 'Upload leads',   icon: 'upload',    route: 'upload',    roles: UPLOAD_ROLES },
      { id: 'intake',    label: 'Intake report',  icon: 'fileText',  route: 'intake',    roles: UPLOAD_ROLES },
      { id: 'analytics', label: 'Analytics',      icon: 'chart',     route: 'analytics', roles: ['admin', 'manager', 'content'] },
      { id: 'exports',   label: 'Data room',      icon: 'download',  route: 'exports',   roles: ['admin', 'manager', 'content'] },
      { id: 'learn',     label: 'Learning Hub',   icon: 'book',      route: 'learn',     roles: CARE_ROLES },
    ],
  },
  {
    section: 'Management',
    items: [
      { id: 'concerns',    label: 'Concerns',        icon: 'alertTriangle', route: 'concerns',  roles: ['admin', 'manager'] },
      { id: 'team',        label: 'Team & Queue',    icon: 'userPlus',    route: 'team',        roles: ['admin', 'manager'] },
      { id: 'leaderboard', label: 'Leaderboard',     icon: 'chart',       route: 'leaderboard', roles: ['admin', 'manager'] },
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
  const hash = (window.location.hash || '').slice(1);
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
    const visibleItems = section.items.filter(item => item.roles.includes(role));
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
          </button>
        `).join('')}
      </div>
    `;
  }).join('');

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo">${icon('handHeart')}</div>
      <div class="sidebar-brand">
        <span class="sidebar-brand-name">Jarurat Care</span>
        <span class="sidebar-brand-sub">Patient Navigator</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${navHTML}
    </nav>
    <div class="sidebar-footer">
      <!-- Install lives here, not in a popup: present in a browser tab,
           absent once the app is installed. -->
      <div id="pwa-install-slot"></div>
      <div class="sidebar-user">
        <button class="sidebar-user-main ${active === 'profile' ? 'active' : ''}" id="sidebar-profile-btn" title="My profile">
          <div class="avatar" style="background: ${avatarColor(profile?.full_name)}">${getInitials(profile?.full_name)}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name">${profile?.full_name || 'User'}</div>
            <div class="sidebar-user-role">${role ? roleLabel(role) : ''}</div>
          </div>
        </button>
        <button class="sidebar-logout-btn" id="sidebar-logout-btn" title="Sign out" aria-label="Sign out">${icon('logOut')}</button>
      </div>
    </div>
  `;

  mountInstallButton(sidebar.querySelector('#pwa-install-slot'));

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
        .in('status', ['open', 'acknowledged']);
      concernCache = { n: count || 0, at: Date.now() };
    } catch { /* leave the pill hidden on failure */ }
  }
  const el = document.getElementById('navcount-concerns');
  if (el) { el.textContent = concernCache.n; el.style.display = concernCache.n ? '' : 'none'; }
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

  el.innerHTML = `
    <div class="bottom-nav-list">
      ${items.map(it => `
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
