// ============================================================
// Patient Navigator — Team & Queue Management v2
// Shows profile-based team hierarchy. Manager can invite team members.
// ============================================================

import { getSupabase } from '../supabase.js';
import { isAdmin, isManagerOrAdmin, getCurrentProfile, signUp } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { formatDateTime, capitalize, getRoleBadge } from '../utils/formatters.js';
import { sanitize, validateEmail, validatePassword } from '../utils/validators.js';

export async function renderTeam(container) {
  if (!isManagerOrAdmin()) {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Only admin and managers can manage teams.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <h1>Team & Queue Management</h1>
      <div class="flex gap-2">
        <button class="btn btn-secondary" id="bulk-queue-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          Add All to Queue
        </button>
        <button class="btn btn-primary" id="invite-team-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          Invite Team Member
        </button>
      </div>
    </div>

    <div class="tabs" id="team-tabs">
      <button class="tab active" data-tab="members">Team Members</button>
      <button class="tab" data-tab="queue">Call Queue</button>
    </div>

    <div id="team-content">
      ${Array(5).fill('<div class="skeleton skeleton-row"></div>').join('')}
    </div>
  `;

  document.getElementById('invite-team-btn')?.addEventListener('click', showInviteTeamMemberModal);
  document.getElementById('bulk-queue-btn')?.addEventListener('click', bulkAddToQueue);

  document.querySelectorAll('#team-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#team-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'queue') loadQueue();
      else loadTeamMembers();
    });
  });

  await loadTeamMembers();
}

// ---- Load Team Members (from profiles, team-tree aware) ----
async function loadTeamMembers() {
  const sb = getSupabase();
  const content = document.getElementById('team-content');
  const profile = getCurrentProfile();

  try {
    const { data, error } = await sb.rpc('get_team_tree');
    if (error) throw error;

    if (!data || data.length === 0) {
      content.innerHTML = '<div class="empty-state"><h3>No team members</h3><p>Invite your first team member to get started.</p></div>';
      return;
    }

    // Build a map of who reports to whom for display
    const byId = {};
    data.forEach(p => { byId[p.id] = p; });

    // Count direct reports for each person
    const directReports = {};
    data.forEach(p => {
      if (p.manager_id && byId[p.manager_id]) {
        directReports[p.manager_id] = (directReports[p.manager_id] || 0) + 1;
      }
    });

    content.innerHTML = `
      <div class="team-grid">
        ${data.map(p => {
          const mgrName = p.manager_id && byId[p.manager_id] ? byId[p.manager_id].full_name : null;
          const reportCount = directReports[p.id] || 0;
          return `
            <div class="card team-card animate-fade-in">
              <div class="flex justify-between items-start">
                <div>
                  <div class="font-medium text-primary" style="font-size:var(--font-lg)">${sanitize(p.full_name)}</div>
                  <div class="text-muted" style="font-size:var(--font-sm)">${getRoleBadge(p.role)}</div>
                  ${mgrName ? `<div class="text-muted" style="font-size:var(--font-xs)">Reports to: ${sanitize(mgrName)}</div>` : ''}
                  ${reportCount > 0 ? `<div class="text-muted" style="font-size:var(--font-xs)">Team size: ${reportCount}</div>` : ''}
                </div>
                <span class="badge ${p.is_active ? 'badge-success' : 'badge-danger'} badge-dot">${p.is_active ? 'Active' : 'Inactive'}</span>
              </div>
              <div class="team-stats">
                <div>
                  <div class="text-muted" style="font-size:var(--font-xs)">Joined</div>
                  <div class="font-medium" style="font-size:var(--font-sm)">${formatDateTime(p.created_at)}</div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    console.error('Load team error:', err);
    showToast('Failed to load team members: ' + err.message, 'error');
  }
}

// ---- Invite Team Member Modal (manager creates a subordinate) ----
async function showInviteTeamMemberModal() {
  const sb = getSupabase();
  const profile = getCurrentProfile();
  const isAdminUser = isAdmin();

  // Build role options based on who is inviting
  const subordinateRoles = [
    { value: 'caller', label: 'Caller' },
    { value: 'caregiver_mentor', label: 'Caregiver Mentor' },
    { value: 'therapist', label: 'Therapist' },
    { value: 'nutritionist', label: 'Nutritionist' },
    { value: 'content', label: 'Content' },
  ];
  // Admin can also create managers
  const allRoles = [
    ...subordinateRoles,
    { value: 'manager', label: 'Manager' },
    { value: 'admin', label: 'Admin' },
  ];
  const roleOptions = (isAdminUser ? allRoles : subordinateRoles)
    .map(r => `<option value="${r.value}">${r.label}</option>`)
    .join('');

  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <form id="invite-team-form">
      <div class="consent-banner" style="background:rgba(6,182,212,0.06);border-color:rgba(6,182,212,0.15)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--color-primary-400);flex-shrink:0;margin-top:2px"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        <p style="color:var(--color-text-secondary);margin:0;font-size:var(--font-sm)">
          ${isAdminUser
            ? 'Create a new account and assign a role. You can optionally assign them to a manager.'
            : 'Create a team member account. They will automatically report to you.'}
        </p>
      </div>
      <div class="form-group">
        <label class="form-label">Email <span class="required">*</span></label>
        <input class="form-input" id="tm-email" type="email" placeholder="user@carcinome.org" required />
      </div>
      <div class="form-group">
        <label class="form-label">Full Name <span class="required">*</span></label>
        <input class="form-input" id="tm-name" placeholder="Full name" required />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="tm-role">${roleOptions}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Temporary Password <span class="required">*</span></label>
          <div class="flex gap-2">
            <input class="form-input" id="tm-password" type="text" value="" style="flex:1" />
            <button type="button" class="btn btn-secondary btn-sm" id="tm-gen-pw" title="Generate password">&#128273;</button>
          </div>
          <span class="form-hint">Min 8 chars, 1 uppercase, 1 number, 1 special</span>
        </div>
      </div>

      ${isAdminUser ? `
      <div class="form-group">
        <label class="form-label">Assign to Manager (optional)</label>
        <select class="form-select" id="tm-manager">
          <option value="">No manager (or I'll assign later)</option>
        </select>
      </div>` : ''}

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="tm-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="tm-submit">Create Account</button>
      </div>
    </form>
  `;

  showModal({ title: 'Invite Team Member', content: formContent, size: 'lg' });

  // Load manager dropdown for admin
  if (isAdminUser) {
    try {
      const { data: managers } = await sb.rpc('get_available_managers');
      const managerOpts = (managers || []).map(m =>
        `<option value="${m.id}">${sanitize(m.full_name)} (${m.role})</option>`
      ).join('');
      const mgrSelect = formContent.querySelector('#tm-manager');
      if (mgrSelect) mgrSelect.innerHTML += managerOpts;
    } catch (e) { /* non-critical */ }
  }

  // Generate password
  formContent.querySelector('#tm-gen-pw').addEventListener('click', () => {
    formContent.querySelector('#tm-password').value = generatePassword();
  });
  formContent.querySelector('#tm-password').value = generatePassword();

  formContent.querySelector('#tm-cancel').addEventListener('click', closeModal);

  formContent.querySelector('#invite-team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = formContent.querySelector('#tm-email').value.trim();
    const name = formContent.querySelector('#tm-name').value.trim();
    const role = formContent.querySelector('#tm-role').value;
    const password = formContent.querySelector('#tm-password').value;
    const submitBtn = formContent.querySelector('#tm-submit');

    if (!validateEmail(email)) { showToast('Please enter a valid email', 'warning'); return; }
    if (!name) { showToast('Full name is required', 'warning'); return; }
    const pwErr = validatePassword(password);
    if (pwErr) { showToast(pwErr, 'warning'); return; }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      // 1. Create the auth user
      const { user } = await signUp(email, password, name);
      const userId = user?.id;
      if (!userId) throw new Error('User creation did not return an ID');

      // 2. Wait for profile trigger
      await new Promise(r => setTimeout(r, 800));

      // 3. Onboard with role + manager
      const managerId = isAdminUser
        ? (formContent.querySelector('#tm-manager')?.value || null)
        : profile.id; // Managers auto-assign to themselves

      await sb.rpc('onboard_team_member', {
        p_user_id: userId,
        p_role: role,
        p_manager_id: managerId || null,
      });

      showToast(`Team member ${name} created!`, 'success');
      closeModal();

      // Show credentials
      setTimeout(() => {
        const credsContent = document.createElement('div');
        credsContent.innerHTML = `
          <div style="text-align:center;padding:var(--space-4)">
            <div style="width:64px;height:64px;border-radius:var(--radius-full);background:rgba(16,185,129,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto var(--space-4)">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2"><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <h3 style="margin-bottom:var(--space-2)">Team Member Created!</h3>
            <p class="text-muted" style="margin-bottom:var(--space-6)">Share these credentials securely:</p>
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
            <div class="form-actions" style="justify-content:center;border:none;margin-top:var(--space-4)">
              <button class="btn btn-primary" id="creds-done">Done</button>
            </div>
          </div>
        `;
        showModal({ title: '', content: credsContent, size: 'lg' });
        credsContent.querySelector('#creds-done')?.addEventListener('click', () => {
          closeModal();
          loadTeamMembers();
        });
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
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ---- Bulk Add to Queue ----
async function bulkAddToQueue() {
  const sb = getSupabase();
  const btn = document.getElementById('bulk-queue-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block"></div> Adding...';

  try {
    const { data: existing } = await sb.from('call_queue').select('patient_id').in('status', ['pending', 'in_progress']);
    const existingIds = new Set((existing || []).map(e => e.patient_id));

    const { data: patients } = await sb.from('patients')
      .select('id')
      .eq('is_active', true)
      .order('created_at');

    const toAdd = (patients || []).filter(p => !existingIds.has(p.id));

    if (toAdd.length === 0) {
      showToast('All patients are already in queue', 'info');
      return;
    }

    const entries = toAdd.map(p => ({
      patient_id: p.id,
      priority: 'medium',
      status: 'pending',
    }));

    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50);
      await sb.from('call_queue').insert(batch);
    }

    showToast(`${toAdd.length} patients added to call queue!`, 'success');

    document.querySelectorAll('#team-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelector('#team-tabs .tab[data-tab="queue"]')?.classList.add('active');
    loadQueue();

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Add All to Queue';
  }
}

// ---- Load Queue ----
async function loadQueue() {
  const sb = getSupabase();
  const content = document.getElementById('team-content');

  try {
    const { data, error } = await sb.from('call_queue')
      .select('*, patients(full_name, patient_code, cancer_type, phone_full), team_members:assigned_to(name)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    if (!data || data.length === 0) {
      content.innerHTML = '<div class="empty-state"><h3>Queue is empty</h3><p>Click "Add All to Queue" to populate the call queue.</p></div>';
      return;
    }

    const statusColors = { pending: 'warning', in_progress: 'info', callback: 'primary', scheduled: 'primary', completed: 'success', skipped: 'danger' };

    content.innerHTML = `
      <div class="flex gap-2 mb-4">
        <button class="btn btn-danger btn-sm" id="clear-completed-btn">Clear Completed</button>
        <button class="btn btn-warning btn-sm" id="reset-skipped-btn">Reset Skipped</button>
      </div>
      <div class="table-container">
        <table class="data-table">
          <thead><tr><th>Patient</th><th>Cancer</th><th>Status</th><th>Assigned To</th><th>Attempts</th><th>Priority</th></tr></thead>
          <tbody>
            ${data.slice(0, 50).map(q => `
              <tr>
                <td><strong class="text-primary">${q.patients?.patient_code || '—'}</strong><br><small class="text-muted">${sanitize(q.patients?.full_name || '—')}</small></td>
                <td>${q.patients?.cancer_type || '—'}</td>
                <td><span class="badge badge-${statusColors[q.status] || 'neutral'} badge-dot">${capitalize((q.status || '').replace('_', ' '))}</span></td>
                <td>${q.team_members?.name || '—'}</td>
                <td>${q.attempts}/${q.max_attempts}</td>
                <td><span class="badge badge-${q.priority === 'high' ? 'danger' : q.priority === 'low' ? 'neutral' : 'warning'}">${capitalize(q.priority || 'medium')}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('clear-completed-btn')?.addEventListener('click', async () => {
      try {
        await sb.from('call_queue').delete().eq('status', 'completed');
        showToast('Completed entries cleared', 'success');
        loadQueue();
      } catch (err) { showToast(err.message, 'error'); }
    });

    document.getElementById('reset-skipped-btn')?.addEventListener('click', async () => {
      try {
        await sb.from('call_queue').update({ status: 'pending', attempts: 0, updated_at: new Date().toISOString() }).eq('status', 'skipped');
        showToast('Skipped entries reset to pending', 'success');
        loadQueue();
      } catch (err) { showToast(err.message, 'error'); }
    });

  } catch (err) {
    console.error('Load queue error:', err);
    showToast('Failed to load queue', 'error');
  }
}
