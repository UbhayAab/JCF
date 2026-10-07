// ============================================================
// Patient Navigator: Admin Page v3 (Users + Invite + Audit + Team Hierarchy)
// ============================================================

import { getSupabase } from '../supabase.js';
import { avatarColor } from '../utils/avatar.js';
import { isAdmin, isManagerOrAdmin, startImpersonation } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { formatDateTime, getRoleBadge } from '../utils/formatters.js';
import { sanitize, validateEmail } from '../utils/validators.js';
import { icon } from '../components/icons.js';

// The one palette (js/utils/avatar.js); same hash, so nobody changes colour.
const avColor = (n) => avatarColor(n);
function inits(n) { return n ? n.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '?'; }

export async function renderAdmin(container, params) {
  if (!isManagerOrAdmin()) {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Only admins and managers can view this page.</p></div>';
    return;
  }

  const isAudit = (params?.id === 'audit' || window.location.hash.includes('audit'));
  const isFiles = isAdmin() && (params?.id === 'files' || window.location.hash.includes('admin/files'));
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
      <button class="tab ${!isAudit && !isFiles ? 'active' : ''}" data-tab="users">User Management</button>
      ${isAdmin() ? `<button class="tab" data-tab="assignment">Assignment policy</button>` : ''}
      ${isAdmin() ? `<button class="tab ${isAudit ? 'active' : ''}" data-tab="audit">Audit Log</button>` : ''}
      ${isAdmin() ? `<button class="tab ${isFiles ? 'active' : ''}" data-tab="files">Stored files</button>` : ''}
    </div>
    <div id="admin-content"></div>
  `;

  document.getElementById('invite-user-btn')?.addEventListener('click', showInviteModal);

  document.querySelectorAll('#admin-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#admin-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'audit') loadAuditLog();
      else if (tab.dataset.tab === 'assignment') loadAssignmentPolicy();
      else if (tab.dataset.tab === 'files') loadStoredFiles();
      else loadUsers();
    });
  });

  if (isAudit) loadAuditLog();
  else if (isFiles) loadStoredFiles();
  else loadUsers();
}

// ---- Stored files: what is left behind, and who erased what (sql/155) ----
// DPDPA: the consent script promises deletion on request. Files of families
// that no longer exist, and pages of uploads that ended discarded or failed,
// stay in storage until someone erases them. This lists them; erasing stays
// one admin's click per row (js/components/fileErasure.js), never a sweep.
async function loadStoredFiles() {
  const sb = getSupabase();
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="card"><div class="spinner"></div></div>';
  let rep;
  let recent = [];
  try {
    const [r1, r2] = await Promise.all([
      sb.rpc('get_leftover_patient_files'),
      sb.from('patient_file_erasures')
        .select('id, patient_id, patient_code, batch_id, reason, requested_by_name, started_at, status, files_found, files_removed, files_left')
        .order('started_at', { ascending: false }).limit(20),
    ]);
    if (r1.error) throw r1.error;
    rep = r1.data || {};
    recent = r2.error ? [] : (r2.data || []);
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><h3>Could not read the stored files</h3><p>${sanitize(e.message)}</p>
      <p class="text-muted">If this says the function does not exist, sql/155 has not been applied yet.</p></div>`;
    return;
  }
  const { fmtBytes } = await import('../components/fileErasure.js');
  const t = rep.totals || {};
  const short = (id) => sanitize(String(id || '').slice(0, 8));
  const gone = rep.families_gone || [];
  const dead = rep.dead_uploads || [];
  const statusLabel = { discarded: 'Discarded', failed: 'Failed', reviewed: 'Reviewed' };

  content.innerHTML = `
    <div class="card" style="padding:18px 20px;margin-bottom:var(--s4)">
      <h3 style="margin:0 0 6px">Files nobody needs any more</h3>
      <p class="text-muted" style="margin:0">Nothing here is erased until an admin presses Erase on its row. Each erasure is
        recorded below: who, when, why and a fingerprint of each file, never its name or content.</p>
      <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:var(--s3);margin-top:var(--s3)">
        <div class="stat-card"><div class="stat-value">${t.files_of_families_gone || 0}</div><div class="stat-label">files of ${t.families_gone || 0} famil${t.families_gone === 1 ? 'y' : 'ies'} no longer in the registry</div></div>
        <div class="stat-card"><div class="stat-value">${t.pages_of_dead_uploads || 0}</div><div class="stat-label">pages (${t.files_of_dead_uploads || 0} files) of ${t.dead_uploads || 0} discarded or failed upload${t.dead_uploads === 1 ? '' : 's'}</div></div>
      </div>
    </div>

    <div class="card" style="padding:16px 18px;margin-bottom:var(--s4)">
      <h3 style="margin:0 0 10px">Families no longer in the registry</h3>
      ${gone.length ? `<div class="table-container"><table class="data-table">
        <thead><tr><th>Folder</th><th>Files</th><th>Size</th><th>Stored</th><th>Last erasure</th><th></th></tr></thead>
        <tbody>${gone.map((g) => `<tr>
          <td class="cell-mono">${short(g.patient_id)}</td><td>${g.files}</td><td>${fmtBytes(g.bytes)}</td>
          <td>${formatDateTime(g.first_at)}${g.last_at !== g.first_at ? ` to ${formatDateTime(g.last_at)}` : ''}</td>
          <td>${g.last_erasure ? `${sanitize(g.last_erasure.status)}, ${formatDateTime(g.last_erasure.at)}` : 'none'}</td>
          <td><button class="btn btn-secondary btn-sm" style="color:var(--danger)" data-erase-family="${sanitize(g.patient_id)}">${icon('trash')}Erase</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="text-muted" style="margin:0">None.</p>'}
    </div>

    <div class="card" style="padding:16px 18px;margin-bottom:var(--s4)">
      <h3 style="margin:0 0 10px">Uploads that ended discarded or failed</h3>
      ${dead.length ? `<div class="table-container"><table class="data-table">
        <thead><tr><th>Family</th><th>Upload</th><th>Pages</th><th>Files</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${dead.map((d) => `<tr>
          <td class="cell-mono">${sanitize(d.patient_code || short(d.patient_id))}</td>
          <td>${sanitize(statusLabel[d.status] || d.status)}${d.deleted ? ' (deleted)' : ''}</td>
          <td>${d.pages}</td><td>${d.files}</td><td>${fmtBytes(d.bytes)}</td><td>${formatDateTime(d.uploaded_at)}</td>
          <td><button class="btn btn-secondary btn-sm" style="color:var(--danger)" data-erase-batch="${sanitize(d.batch_id)}" data-patient="${sanitize(d.patient_id)}" data-code="${sanitize(d.patient_code || '')}">${icon('trash')}Erase</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="text-muted" style="margin:0">None.</p>'}
    </div>

    <div class="card" style="padding:16px 18px">
      <h3 style="margin:0 0 10px">Erasures on record</h3>
      ${recent.length ? `<div class="table-container"><table class="data-table">
        <thead><tr><th>When</th><th>By</th><th>Family</th><th>What</th><th>Files</th><th>Result</th><th>Why</th></tr></thead>
        <tbody>${recent.map((r) => `<tr>
          <td>${formatDateTime(r.started_at)}</td><td>${sanitize(r.requested_by_name || 'an admin')}</td>
          <td class="cell-mono">${sanitize(r.patient_code || short(r.patient_id))}</td>
          <td>${r.batch_id ? 'one upload' : 'every file'}</td>
          <td>${r.files_removed ?? 0} of ${r.files_found}</td>
          <td><span class="badge ${r.status === 'done' ? 'badge-success' : r.status === 'partial' ? 'badge-warning' : 'badge-info'}">${sanitize(r.status)}</span></td>
          <td>${sanitize(r.reason)}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="text-muted" style="margin:0">No erasures yet.</p>'}
    </div>`;

  const { openEraseFiles } = await import('../components/fileErasure.js');
  content.querySelectorAll('[data-erase-family]').forEach((b) => b.addEventListener('click', () =>
    openEraseFiles({
      patientId: b.dataset.eraseFamily,
      label: `a family no longer in the registry (${b.dataset.eraseFamily.slice(0, 8)})`,
      defaultReason: 'Leftover files of a family that no longer exists',
      onDone: () => loadStoredFiles(),
    })));
  content.querySelectorAll('[data-erase-batch]').forEach((b) => b.addEventListener('click', () =>
    openEraseFiles({
      patientId: b.dataset.patient,
      batchId: b.dataset.eraseBatch,
      label: `an upload of ${b.dataset.code || 'a family'}`,
      defaultReason: 'Pages of an upload that was discarded or failed',
      onDone: () => loadStoredFiles(),
    })));
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
        ${email && email !== '(their email)' ? `<div class="form-group"><label class="form-label">Email</label><code style="color:var(--primary-ink)">${email}</code></div>` : ''}
        <div class="form-group" style="margin-bottom:${role === 'reset' ? '0' : 'var(--s4)'}"><label class="form-label">First-time password</label><code style="color:var(--primary-ink)">${password}</code></div>
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
// ---- Assignment policy (sql/125) ----
// Reported 09/09 by the Ground POC lead: "patients marked as inactive are
// being reassigned within a week ... extend the reassignment timeline to at
// least one month", and defer a completely disinterested family by 2-3 months.
//
// The week was real and it was not a setting anyone could change. It came out
// of two literals meeting: auto_followup_date() schedules a no-answer +7 days,
// and the sql/40 float rule moves ownership of anyone with 0 or 1
// conversations every time their follow-up comes due. Measured over 90 days of
// patient_assignment_history, the minimum gap between two automatic owner
// changes on one patient was exactly 7 days, and the median was 7.
//
// These four numbers replace that. They are read by the database on every
// automatic reassignment, so changing one here changes tonight's build.
async function loadAssignmentPolicy() {
  const sb = getSupabase();
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="card"><div class="spinner"></div></div>';

  const { data, error } = await sb.from('assignment_policy')
    .select('*').eq('is_active', true).maybeSingle();
  if (error) {
    content.innerHTML = `<div class="empty-state"><h3>Could not load the policy</h3>
      <p>${sanitize(error.message)}</p>
      <p class="text-muted">If this says the relation does not exist, sql/125 has not been applied yet.</p></div>`;
    return;
  }
  if (!data) {
    content.innerHTML = '<div class="empty-state"><h3>No active policy row</h3><p>sql/125 seeds one. Run it.</p></div>';
    return;
  }

  const field = (id, label, val, hint) => `
    <div class="form-group">
      <label class="form-label" for="${id}">${label}</label>
      <input class="form-input" id="${id}" type="number" min="0" max="365" step="1" value="${val}" style="max-width:140px" />
      <p class="form-hint">${hint}</p>
    </div>`;

  content.innerHTML = `
    <div class="card" style="padding:20px 22px;max-width:760px">
      <h3 style="margin:0 0 6px">How long an automatic reassignment waits</h3>
      <p class="text-muted" style="margin:0 0 var(--s4)">
        A manager moving somebody by hand is never blocked by any of these. They only hold the
        nightly build and the auto-distribute pass, and they never leave a patient with nobody.</p>
      ${field('ap-float', 'After an automatic reassignment, wait (days)', data.float_hold_days,
        'Was effectively 7. The field asked for at least a month.')}
      ${field('ap-inactive', 'When a patient is marked inactive or not engaging, wait (days)', data.inactive_hold_days,
        'They stop being passed from mentor to mentor while they are not taking part.')}
      ${field('ap-dis', 'When a patient is marked completely disinterested, wait (days)', data.disinterested_hold_days,
        'The field asked for 2 to 3 months. 60 to 90 is that range; 75 is the middle.')}
      <label class="svc" style="display:flex;align-items:flex-start;gap:9px;padding:10px 12px;margin-top:var(--s3)">
        <input type="checkbox" id="ap-auto" ${data.auto_release_holds ? 'checked' : ''} />
        <span>Let a deferral run out by itself
          <span style="display:block;font-size:12px;color:var(--ink-3);margin-top:2px">
            At 11:50 IST, ten minutes before the daily build, anyone whose deferral has expired goes back
            into the call order with a note on their record saying why they came back. Turn this off and
            somebody has to remember instead.</span></span>
      </label>
      <div class="form-actions" style="margin-top:var(--s4)">
        <button class="btn btn-primary" id="ap-save">Save policy</button>
      </div>
      <p class="text-muted" style="font-size:12px;margin-top:10px">
        Last changed ${formatDateTime(data.updated_at)}.</p>
    </div>`;

  document.getElementById('ap-save').addEventListener('click', async () => {
    const btn = document.getElementById('ap-save');
    const num = (id) => parseInt(document.getElementById(id).value, 10);
    const patch = {
      float_hold_days: num('ap-float'),
      inactive_hold_days: num('ap-inactive'),
      disinterested_hold_days: num('ap-dis'),
      auto_release_holds: document.getElementById('ap-auto').checked,
      updated_at: new Date().toISOString(),
    };
    if (Object.values(patch).some(v => typeof v === 'number' && (!Number.isFinite(v) || v < 0 || v > 365))) {
      showToast('Every interval has to be a whole number of days between 0 and 365.', 'warning');
      return;
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    // Read the row back rather than trusting a 204. The CHECK constraint is
    // the real gate and a client-side range test is only a courtesy.
    const { data: saved, error: sErr } = await sb.from('assignment_policy')
      .update(patch).eq('id', data.id).select().maybeSingle();
    if (sErr || !saved) {
      showToast('Could not save: ' + (sErr?.message || 'the server did not confirm the change'), 'error');
      btn.disabled = false; btn.textContent = 'Save policy';
      return;
    }
    showToast(`Saved. From tonight's build, an automatic reassignment waits ${saved.float_hold_days} days.`, 'success');
    loadAssignmentPolicy();
  });
}

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
