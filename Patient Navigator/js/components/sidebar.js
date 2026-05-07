// ============================================================
// Patient Navigator — Sidebar Component
// ============================================================

import { getCurrentProfile, getUserRole, isAdmin, isManagerOrAdmin, signOut } from '../auth.js';
import { navigate, getCurrentRoute } from '../router.js';
import { showToast } from './toast.js';

const ALL_ROLES = ['admin', 'manager', 'caller', 'caregiver_mentor', 'therapist', 'nutritionist', 'content'];

const NAV_ITEMS = [
  {
    section: 'Main',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', route: 'dashboard', roles: ALL_ROLES },
      { id: 'calling', label: 'Calling Portal', icon: 'phone-outgoing', route: 'calling', roles: ALL_ROLES },
      { id: 'patients', label: 'Patients', icon: 'users', route: 'patients', roles: ALL_ROLES },
      { id: 'calls', label: 'Call Logs', icon: 'phone', route: 'calls', roles: ALL_ROLES },
      { id: 'analytics', label: 'Analytics', icon: 'bar-chart', route: 'analytics', roles: ['admin', 'manager', 'content'] },
    ]
  },
  {
    section: 'Management',
    items: [
      { id: 'team', label: 'Team & Queue', icon: 'users-group', route: 'team', roles: ['admin', 'manager'] },
      { id: 'admin-users', label: 'User Management', icon: 'shield', route: 'admin/users', roles: ['admin'] },
      { id: 'admin-audit', label: 'Audit Log', icon: 'file-text', route: 'admin/audit', roles: ['admin'] },
    ]
  }
];

const ICONS = {
  'layout-dashboard': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
  'users': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  'phone': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  'shield': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  'file-text': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  'heart': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  'bar-chart': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  'phone-outgoing': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 7 23 1 17 1"/><line x1="16" y1="8" x2="23" y2="1"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/></svg>',
  'users-group': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  'log-out': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  'user': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  'menu': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>',
};

function getAvatarColor(name) {
  const colors = ['#06b6d4', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export function renderSidebar() {
  const profile = getCurrentProfile();
  const role = getUserRole();
  const currentRouteId = getCurrentRoute();

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const navHTML = NAV_ITEMS.map(section => {
    const visibleItems = section.items.filter(item => item.roles.includes(role));
    if (visibleItems.length === 0) return '';
    return `
      <div class="nav-section">
        <div class="nav-section-title">${section.section}</div>
        ${visibleItems.map(item => `
          <button class="nav-item ${currentRouteId === item.route ? 'active' : ''}"
                  data-route="${item.route}" id="nav-${item.id}">
            ${ICONS[item.icon] || ''}
            <span>${item.label}</span>
          </button>
        `).join('')}
      </div>
    `;
  }).join('');

  const avatarColor = getAvatarColor(profile?.full_name);
  const initials = getInitials(profile?.full_name);

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo">${ICONS.heart}</div>
      <div class="sidebar-brand">
        <span class="sidebar-brand-name">Carcinome</span>
        <span class="sidebar-brand-sub">Patient Navigator</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${navHTML}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-user" id="sidebar-user-btn">
        <div class="avatar" style="background: ${avatarColor}">${initials}</div>
        <div class="sidebar-user-info">
          <div class="sidebar-user-name">${profile?.full_name || 'User'}</div>
          <div class="sidebar-user-role">${role || 'Loading...'}</div>
        </div>
        <div style="width:18px;height:18px;flex-shrink:0;color:var(--color-text-muted)">${ICONS['log-out']}</div>
      </div>
    </div>
  `;

  // Navigation click handlers
  sidebar.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.route);
      // Close mobile sidebar
      sidebar.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('active');
    });
  });

  // Logout handler
  document.getElementById('sidebar-user-btn')?.addEventListener('click', async () => {
    try {
      await signOut();
      navigate('login');
      showToast('Signed out successfully', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  renderBottomNav(role, currentRouteId);
}

// Mobile bottom-nav: 5 priority destinations. Admin/manager get "Team" in
// place of "Profile" since profile is reachable from the header avatar.
function renderBottomNav(role, currentRouteId) {
  const el = document.getElementById('bottom-nav');
  if (!el) return;

  const isManagerOrAdminRole = ['admin', 'manager'].includes(role);
  const items = [
    { id: 'dashboard', label: 'Home',    route: 'dashboard', icon: 'layout-dashboard' },
    { id: 'calling',   label: 'Call',    route: 'calling',   icon: 'phone-outgoing' },
    { id: 'patients',  label: 'Patients',route: 'patients',  icon: 'users' },
    { id: 'calls',     label: 'Logs',    route: 'calls',     icon: 'phone' },
    isManagerOrAdminRole
      ? { id: 'team',    label: 'Team',    route: 'team',    icon: 'users-group' }
      : { id: 'profile', label: 'Profile', route: 'profile', icon: 'user' },
  ];

  el.innerHTML = `
    <div class="bottom-nav-list">
      ${items.map(it => `
        <button class="bottom-nav-item ${currentRouteId === it.route ? 'active' : ''}" data-route="${it.route}" aria-label="${it.label}">
          ${ICONS[it.icon] || ''}
          <span>${it.label}</span>
        </button>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('.bottom-nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.route));
  });
}
