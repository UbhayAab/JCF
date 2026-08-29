// ============================================================
// Patient Navigator: Admin Page v3 (Users + Invite + Audit + Team Hierarchy)
// ============================================================

import { getSupabase } from '../supabase.js';
import { isAdmin, isManagerOrAdmin, startImpersonation } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { formatDateTime, getRoleBadge } from '../utils/formatters.js';
import { sanitize, validateEmail } from '../utils/validators.js';
import { icon } from '../components/icons.js';

const AV_COLORS = ['#006469', '#7A4C00', '#5B4892', '#295B86', '#106841', '#953028'];
function avColor(n) { let h = 0; for (let i = 0; i < (n || '').length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return AV_COLORS[Math.abs(h) % AV_COLORS.length]; }
function inits(n) { return n ? n.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '?'; }

export async function renderAdmin(container, params) {
  if (!isManagerOrAdmin()) {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Only admins and managers can view this page.</p></div>';
    return;
  }

  const isAudit = (params?.id === 'audit' || window.location.hash.includes('audit'));
  container.innerHTML = `
    <div class="page-header">
      <h1>Administration</h1>
      <div class="flex gap-2">
        <button class="btn btn-primary" id="invite-user-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          Invite User
        </button>
      </div>
    </div>
    <div class="tabs" id="admin-tabs">
      <button class="tab ${!isAudit ? 'active' : ''}" data-tab="users">User Management</button>
      ${isAdmin() ? `<button class="tab ${isAudit ? 'active' : ''}" data-tab="audit">Audit Log</button>` : ''}
    </div>
    <div id="admin-content"></div>
  `;

  document.getElementById('invite-user-btn')?.addEventListener('click', showInviteModal);

  document.querySelectorAll('#admin-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#admin-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'audit') loadAuditLog();
      else loadUsers();
    });
  });

  if (isAudit) loadAuditLog();
  else loadUsers();
}

// ---- Create User (server-side, org default password) ----
// Every new account starts on the shared default password and is
// forced to set a personal one on first login.
async function showInviteModal() {
  const sb = getSupabase();

  let managerOptions = '';
  try {
    const { data: managers } = await sb.rpc('get_available_managers');
    managerOptions = (managers || []).map(m =>
      `<option value="${m.id}">${sanitize(m.full_name)} (${m.role})</option>`
    ).join('');
  } catch (e) { /* non-critical */ }

  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <form id="invite-form">
      <div class="consent-banner">
        ${icon('key')}
        <p style="margin:0">New accounts start on the team default password and must set their own the first time they sign in. Users can change their own password later; only admins can reset forgotten passwords.</p>
      </div>
      <div class="form-group">
        <label class="form-label">Email <span class="required">*</span></label>
        <input class="form-input" id="inv-email" type="email" placeholder="firstname@carcinome.org" required />
      </div>
      <div class="form-group">
        <label class="form-label">Full Name <span class="required">*</span></label>
        <input class="form-input" id="inv-name" placeholder="Full name" required />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="inv-role">
            <option value="caregiver_mentor">Caregiver Mentor</option>
            <option value="ground_poc">Ground POC</option>
            <option value="therapist">Therapist</option>
            <option value="nutritionist">Nutritionist</option>
            <option value="content">Content</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Manager (optional)</label>
          <select class="form-select" id="inv-manager">
            <option value="">No manager</option>
            ${managerOptions}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="inv-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="inv-submit">Create Account</button>
      </div>
    </form>
  `;

  showModal({ title: 'Add a team member', content: formContent, size: 'lg' });
  formContent.querySelector('#inv-cancel').addEventListener('click', () => closeModal());

  formContent.querySelector('#invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = formContent.querySelector('#inv-email').value.trim();
    const name = formContent.querySelector('#inv-name').value.trim();
    const role = formContent.querySelector('#inv-role').value;
    const managerId = formContent.querySelector('#inv-manager').value || null;
    const submitBtn = formContent.querySelector('#inv-submit');

    if (!validateEmail(email)) { showToast('Please enter a valid email', 'warning'); return; }
    if (!name) { showToast('Full name is required', 'warning'); return; }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const { data, error } = await sb.rpc('admin_create_user', {
        p_email: email, p_full_name: name, p_role: role, p_manager_id: managerId,
      });
      if (error) throw error;
      closeModal();
      showCredentialsModal(name, data.email, data.default_password, role);
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account';
    }
  });
}

function showCredentialsModal(name, email, password, role) {
  const credsContent = document.createElement('div');
  credsContent.innerHTML = `
    <div style="text-align:center;padding:var(--s4)">
      <div class="ico-wrap" style="width:60px;height:60px;border-radius:50%;background:var(--ok-soft);color:var(--ok);display:grid;place-items:center;margin:0 auto var(--s4)">${icon('checkCircle')}</div>
      <h3 style="margin-bottom:var(--s2)">${sanitize(name)} can sign in now</h3>
      <p style="color:var(--ink-2);margin-bottom:var(--s5)">Share these once. They'll be asked to set their own password immediately:</p>
      <div class="card" style="text-align:left">
        ${email && email !== '(their email)' ? `<div class="form-group"><label class="form-label">Email</label><code style="color:var(--primary)">${email}</code></div>` : ''}
        <div class="form-group" style="margin-bottom:${role === 'reset' ? '0' : 'var(--s4)'}"><label class="form-label">First-time password</label><code style="color:var(--primary)">${password}</code></div>
        ${role !== 'reset' ? `<div class="form-group" style="margin:0"><label class="form-label">Role</label>${getRoleBadge(role)}</div>` : ''}
      </div>
      <div class="form-actions" style="justify-content:center;border:none;margin-top:var(--s4)">
        <button class="btn btn-primary" id="creds-done">Done</button>
      </div>
    </div>
  `;
  showModal({ title: 'Account created', content: credsContent, size: 'lg' });
  credsContent.querySelector('#creds-done')?.addEventListener('click', () => { closeModal(); loadUsers(); });
}

// ---- Load Users (with manager column) ----
async function loadUsers() {
  const sb = getSupabase();
  const content = document.getElementById('admin-content');
  content.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');

  try {
    // Fetch profiles + manager names in one go
    const { data: profiles, error } = await sb
      .from('profiles')
      .select('*, manager:manager_id(id, full_name, role)')
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Load available managers + the many-to-many manager tags (profile_managers).
    const { data: managers } = await sb.rpc('get_available_managers');
    const { data: pmRows } = await sb.from('profile_managers').select('profile_id, manager_id');
    const mgrById = new Map((managers || []).map(m => [m.id, m]));
    const managersOf = new Map();
    (pmRows || []).forEach(r => {
      if (!managersOf.has(r.profile_id)) managersOf.set(r.profile_id, []);
      managersOf.get(r.profile_id).push(r.manager_id);
    });
    // Managers tagged on a user: prefer profile_managers, fall back to the
    // legacy single manager_id so nothing looks empty after the migration.
    const assignedManagerIds = (u) => {
      const ids = managersOf.get(u.id);
      if (ids && ids.length) return ids;
      return u.manager_id ? [u.manager_id] : [];
    };
    const mgrNameById = (id, u) => sanitize(mgrById.get(id)?.full_name || (u?.manager?.id === id ? u.manager.full_name : '') || 'Unknown');
    const chipsFor = (u) => {
      const ids = assignedManagerIds(u).filter(id => id !== u.id);
      return ids.length
        ? ids.map(id => `<span class="badge badge-neutral badge-dot" style="font-size:var(--font-xs)">${mgrNameById(id, u)}</span>`).join(' ')
        : '<span class="text-muted" style="font-size:var(--font-xs)">No manager</span>';
    };

    const roleOpts = (cur) => [['caregiver_mentor','Caregiver Mentor'],['ground_poc','Ground POC'],['therapist','Therapist'],['nutritionist','Nutritionist'],['content','Content'],['uploader','Intake / Uploader'],['manager','Manager'],...(isAdmin()?[['admin','Admin']]:[])]
      .map(([v,l]) => `<option value="${v}" ${cur===v?'selected':''}>${l}</option>`).join('');
    content.innerHTML = `
      <p class="muted" style="margin:0 0 var(--s4);color:var(--ink-3);font:var(--t-sm)">Change a role, assign managers, reset a password, open an account, or deactivate one. For day-to-day “off today”, use Team &amp; Queue → Availability.</p>
      <div class="user-list">
        ${(profiles || []).map(u => `
          <div class="urow">
            <span class="avatar avatar-sm" style="background:${avColor(u.full_name)}">${inits(u.full_name)}</span>
            <span class="urow-name">${sanitize(u.full_name)}${u.is_active ? '' : ' <span class="badge badge-warning badge-dot">Inactive</span>'}</span>
            <select class="form-select urow-role" data-user-id="${u.id}" data-action="role" title="Role">${roleOpts(u.role)}</select>
            <button class="btn btn-ghost btn-sm" data-user-id="${u.id}" data-action="managers">Managers</button>
            <button class="btn btn-ghost btn-sm" data-user-id="${u.id}" data-user-name="${sanitize(u.full_name)}" data-action="resetpw">Reset</button>
            <button class="btn btn-ghost btn-sm" data-user-id="${u.id}" data-action="impersonate">Open as</button>
            <button class="btn btn-ghost btn-sm" data-user-id="${u.id}" data-action="toggle" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Activate'}</button>
          </div>`).join('')}
      </div>
    `;

    // Role change handlers
    content.querySelectorAll('select[data-action="role"]').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          const { error } = await sb.rpc('update_user_role', { target_user_id: sel.dataset.userId, new_role: sel.value });
          if (error) throw error;
          showToast('Role updated', 'success');
        } catch (err) {
          showToast(err.message, 'error');
          loadUsers();
        }
      });
    });

    // Multi-manager handlers: open a checkbox modal; save via set_user_managers.
    content.querySelectorAll('button[data-action="managers"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = (profiles || []).find(p => p.id === btn.dataset.userId);
        if (u) openManagersModal(u, managers || [], assignedManagerIds(u), () => loadUsers());
      });
    });

    // Toggle active handlers
    content.querySelectorAll('button[data-action="toggle"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newStatus = btn.dataset.active !== 'true';
        try {
          const { error } = await sb.rpc('toggle_user_active', { target_user_id: btn.dataset.userId, active_status: newStatus });
          if (error) throw error;
          showToast(`User ${newStatus ? 'activated' : 'deactivated'}`, 'success');
          loadUsers();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    // Reset-password handlers (back to the team default + forced change)
    content.querySelectorAll('button[data-action="resetpw"]').forEach(btn => {
      btn.addEventListener('click', () => {
        confirmModal(
          `Reset <strong>${btn.dataset.userName}</strong>'s password to the team default? They'll set a new personal password on their next sign-in.`,
          async () => {
            try {
              const { data, error } = await sb.rpc('admin_reset_password', { p_user_id: btn.dataset.userId });
              if (error) throw error;
              showCredentialsModal(btn.dataset.userName, '(their email)', data.default_password, 'reset');
            } catch (err) { showToast(err.message, 'error'); }
          },
          { title: 'Reset password', confirmLabel: 'Reset', danger: false }
        );
      });
    });

    // "Open as user": managers/admins open any account (master access).
    content.querySelectorAll('button[data-action="impersonate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = (profiles || []).find(p => p.id === btn.dataset.userId);
        if (u && startImpersonation(u)) location.reload();
      });
    });
  } catch (err) {
    console.error('Load users error:', err);
    showToast('Failed to load users', 'error');
  }
}

// ---- Multi-manager assignment modal ----
// Visibility is org-wide already, so manager tags are a reporting label. A user
// can report to several managers. Saves the full set via set_user_managers().
function openManagersModal(user, allManagers, currentIds, onSaved) {
  const sb = getSupabase();
  const options = (allManagers || []).filter(m => m.id !== user.id);
  const current = new Set(currentIds || []);
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="color:var(--ink-2);font-size:14px;margin-bottom:var(--s4)">Tag the manager(s) <strong>${sanitize(user.full_name)}</strong> reports to. Every manager can already see all caregiver mentors. This is just for organising teams. Pick as many as apply.</p>
    ${options.length ? `<div style="display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto">
      ${options.map(m => `
        <label class="card" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;margin:0">
          <input type="checkbox" value="${m.id}" ${current.has(m.id) ? 'checked' : ''} style="width:18px;height:18px;flex:none" />
          <span style="flex:1"><strong>${sanitize(m.full_name)}</strong> <span class="text-muted" style="font-size:var(--font-xs)">(${m.role})</span></span>
        </label>`).join('')}
    </div>` : '<p class="text-muted">No managers or admins exist yet to assign.</p>'}
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="mm-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="mm-save">${icon('check')}Save managers</button>
    </div>`;
  showModal({ title: 'Managers for ' + sanitize(user.full_name), content: el, size: 'lg' });
  el.querySelector('#mm-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#mm-save').addEventListener('click', async () => {
    const ids = [...el.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
    const btn = el.querySelector('#mm-save'); btn.disabled = true; btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const { error } = await sb.rpc('set_user_managers', { p_user_id: user.id, p_manager_ids: ids });
      if (error) throw error;
      showToast('Managers updated', 'success');
      closeModal();
      if (onSaved) onSaved();
    } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.innerHTML = `${icon('check')}Save managers`; }
  });
}

// ---- Load Audit Log ----
async function loadAuditLog() {
  const sb = getSupabase();
  const content = document.getElementById('admin-content');
  content.innerHTML = Array(10).fill('<div class="skeleton skeleton-row"></div>').join('');

  try {
    const { data, error } = await sb.from('audit_log')
      .select('*, profiles:user_id(full_name)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    if (!data || data.length === 0) {
      content.innerHTML = '<div class="empty-state"><h3>No audit entries</h3></div>';
      return;
    }

    content.innerHTML = `
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Table</th><th>Record</th></tr></thead>
          <tbody>
            ${data.map(a => `
              <tr>
                <td>${formatDateTime(a.created_at)}</td>
                <td>${a.profiles?.full_name || 'N/A'}</td>
                <td><span class="badge ${a.action === 'DELETE' ? 'badge-danger' : a.action === 'INSERT' ? 'badge-success' : 'badge-info'}">${a.action}</span></td>
                <td>${a.table_name}</td>
                <td class="text-muted">${(a.record_id || '').slice(0, 8)}...</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.error('Audit log error:', err);
    showToast('Failed to load audit log', 'error');
  }
}
