// ============================================================
// Patient Navigator — Admin Page v2 (Users + Invite + Audit)
// ============================================================

import { getSupabase } from '../supabase.js';
import { isAdmin, signUp } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { formatDateTime, capitalize, getRoleBadge } from '../utils/formatters.js';
import { sanitize, validateEmail, validatePassword } from '../utils/validators.js';

export async function renderAdmin(container, params) {
  if (!isAdmin()) {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Only administrators can view this page.</p></div>';
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
      <button class="tab ${isAudit ? 'active' : ''}" data-tab="audit">Audit Log</button>
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

// ---- Invite User Modal ----
function showInviteModal() {
  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <form id="invite-form">
      <div class="consent-banner" style="background:rgba(6,182,212,0.06);border-color:rgba(6,182,212,0.15)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--color-primary-400);flex-shrink:0;margin-top:2px"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        <p style="color:var(--color-text-secondary);margin:0;font-size:var(--font-sm)">
          Create a new user account with a pre-assigned role. Share the temporary password securely — the user should change it on first login.
        </p>
      </div>
      <div class="form-group">
        <label class="form-label">Email <span class="required">*</span></label>
        <input class="form-input" id="inv-email" type="email" placeholder="user@carcinome.org" required />
      </div>
      <div class="form-group">
        <label class="form-label">Full Name <span class="required">*</span></label>
        <input class="form-input" id="inv-name" placeholder="Full name" required />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="inv-role">
            <option value="caller">Caller</option>
            <option value="caregiver_mentor">Caregiver Mentor</option>
            <option value="therapist">Therapist</option>
            <option value="nutritionist">Nutritionist</option>
            <option value="content">Content</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Temporary Password <span class="required">*</span></label>
          <div class="flex gap-2">
            <input class="form-input" id="inv-password" type="text" value="" style="flex:1" />
            <button type="button" class="btn btn-secondary btn-sm" id="inv-gen-pw" title="Generate password">🔑</button>
          </div>
          <span class="form-hint">Min 8 chars, 1 uppercase, 1 number, 1 special</span>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="inv-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="inv-submit">Create Account</button>
      </div>
    </form>
  `;

  showModal({ title: 'Invite New User', content: formContent, size: 'lg' });

  // Generate password
  formContent.querySelector('#inv-gen-pw').addEventListener('click', () => {
    const pw = generatePassword();
    formContent.querySelector('#inv-password').value = pw;
  });
  // Auto-generate on open
  formContent.querySelector('#inv-password').value = generatePassword();

  formContent.querySelector('#inv-cancel').addEventListener('click', closeModal);

  formContent.querySelector('#invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = formContent.querySelector('#inv-email').value.trim();
    const name = formContent.querySelector('#inv-name').value.trim();
    const role = formContent.querySelector('#inv-role').value;
    const password = formContent.querySelector('#inv-password').value;
    const submitBtn = formContent.querySelector('#inv-submit');

    if (!validateEmail(email)) { showToast('Please enter a valid email', 'warning'); return; }
    if (!name) { showToast('Full name is required', 'warning'); return; }
    const pwErr = validatePassword(password);
    if (pwErr) { showToast(pwErr, 'warning'); return; }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      // 1. Create the auth user via signUp
      await signUp(email, password, name);

      // 2. Update their role if not default 'caller'
      if (role !== 'caller') {
        const sb = getSupabase();
        // Small delay to ensure the profile trigger has fired
        await new Promise(r => setTimeout(r, 1000));

        // Find the new user's profile by matching the name (since we can't get the auth ID directly)
        const { data: profiles } = await sb.from('profiles').select('id, full_name').eq('full_name', name).order('created_at', { ascending: false }).limit(1);
        if (profiles && profiles.length > 0) {
          const { error } = await sb.rpc('update_user_role', { target_user_id: profiles[0].id, new_role: role });
          if (error) console.warn('Role update failed:', error.message);
        }
      }

      showToast(`Account created for ${name}!`, 'success');

      // Show credentials in a follow-up modal
      closeModal();
      setTimeout(() => {
        const credsContent = document.createElement('div');
        credsContent.innerHTML = `
          <div style="text-align:center;padding:var(--space-4)">
            <div style="width:64px;height:64px;border-radius:var(--radius-full);background:rgba(16,185,129,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto var(--space-4)">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2"><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <h3 style="margin-bottom:var(--space-2)">Account Created!</h3>
            <p class="text-muted" style="margin-bottom:var(--space-6)">Share these credentials securely with the user:</p>
            <div class="card" style="text-align:left;background:var(--color-bg-tertiary)">
              <div class="form-group" style="margin-bottom:var(--space-2)">
                <label class="form-label" style="font-size:var(--font-xs)">Email</label>
                <code class="text-primary">${email}</code>
              </div>
              <div class="form-group" style="margin-bottom:var(--space-2)">
                <label class="form-label" style="font-size:var(--font-xs)">Password</label>
                <code class="text-primary">${password}</code>
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:var(--font-xs)">Role</label>
                <span>${getRoleBadge(role)}</span>
              </div>
            </div>
            <p class="text-muted" style="margin-top:var(--space-4);font-size:var(--font-xs)">
              ⚠️ Ask the user to change their password after first login.
            </p>
            <div class="form-actions" style="justify-content:center;border:none;margin-top:var(--space-4)">
              <button class="btn btn-primary" id="creds-done">Done</button>
            </div>
          </div>
        `;
        showModal({ title: '', content: credsContent, size: 'lg' });
        credsContent.querySelector('#creds-done')?.addEventListener('click', () => { closeModal(); loadUsers(); });
      }, 300);

    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account';
    }
  });
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const nums = '23456789';
  const special = '@#$!%&';
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += special[Math.floor(Math.random() * special.length)];
  pw += nums[Math.floor(Math.random() * nums.length)];
  for (let i = 0; i < 7; i++) {
    const all = upper + lower + nums;
    pw += all[Math.floor(Math.random() * all.length)];
  }
  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ---- Load Users ----
async function loadUsers() {
  const sb = getSupabase();
  const content = document.getElementById('admin-content');
  content.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');

  try {
    const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: true });
    if (error) throw error;

    content.innerHTML = `
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>Name</th><th>Email/ID</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody>
            ${(data || []).map(u => `
              <tr class="animate-fade-in">
                <td><strong class="text-primary">${sanitize(u.full_name)}</strong></td>
                <td class="text-muted">${u.id.slice(0,8)}...</td>
                <td>${getRoleBadge(u.role)}</td>
                <td>${u.is_active ? '<span class="badge badge-success badge-dot">Active</span>' : '<span class="badge badge-warning badge-dot">Pending/Inactive</span>'}</td>
                <td>${formatDateTime(u.created_at)}</td>
                <td>
                  <select class="form-select btn-sm" style="width:auto;height:30px;font-size:var(--font-xs)" data-user-id="${u.id}" data-action="role">
                    <option value="caller" ${u.role === 'caller' ? 'selected' : ''}>Caller</option>
                    <option value="caregiver_mentor" ${u.role === 'caregiver_mentor' ? 'selected' : ''}>Caregiver Mentor</option>
                    <option value="therapist" ${u.role === 'therapist' ? 'selected' : ''}>Therapist</option>
                    <option value="nutritionist" ${u.role === 'nutritionist' ? 'selected' : ''}>Nutritionist</option>
                    <option value="content" ${u.role === 'content' ? 'selected' : ''}>Content</option>
                    <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>Manager</option>
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                  </select>
                  <button class="btn btn-ghost btn-sm" data-user-id="${u.id}" data-action="toggle" data-active="${u.is_active}" title="${u.is_active ? 'Deactivate' : 'Approve / Activate'}">
                    ${u.is_active ? '🔒' : '✅'}
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
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
  } catch (err) {
    console.error('Load users error:', err);
    showToast('Failed to load users', 'error');
  }
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
                <td>${a.profiles?.full_name || '—'}</td>
                <td><span class="badge ${a.action === 'DELETE' ? 'badge-danger' : a.action === 'INSERT' ? 'badge-success' : 'badge-info'}">${a.action}</span></td>
                <td>${a.table_name}</td>
                <td class="text-muted">${(a.record_id || '').slice(0,8)}...</td>
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
