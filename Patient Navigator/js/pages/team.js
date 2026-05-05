// ============================================================
// Patient Navigator — Team & Queue Management
// Admin page for managing callers and call queue
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { formatDateTime, capitalize } from '../utils/formatters.js';
import { sanitize } from '../utils/validators.js';

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
        <button class="btn btn-primary" id="add-team-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          Add Team Member
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

  document.getElementById('add-team-btn')?.addEventListener('click', showAddTeamMemberModal);
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

async function loadTeamMembers() {
  const sb = getSupabase();
  const content = document.getElementById('team-content');

  try {
    const { data, error } = await sb.from('team_members').select('*').order('name');
    if (error) throw error;

    if (!data || data.length === 0) {
      content.innerHTML = '<div class="empty-state"><h3>No team members</h3><p>Add your first team member to get started.</p></div>';
      return;
    }

    content.innerHTML = `
      <div class="team-grid">
        ${data.map(tm => `
          <div class="card team-card animate-fade-in">
            <div class="flex justify-between items-start">
              <div>
                <div class="font-medium text-primary" style="font-size:var(--font-lg)">${sanitize(tm.name)}</div>
                <div class="text-muted" style="font-size:var(--font-sm)">${tm.phone || 'No phone'}</div>
                ${tm.email ? `<div class="text-muted" style="font-size:var(--font-xs)">${tm.email}</div>` : ''}
              </div>
              <span class="badge ${tm.is_active ? 'badge-success' : 'badge-danger'} badge-dot">${tm.is_active ? 'Active' : 'Inactive'}</span>
            </div>
            <div class="team-stats">
              <div>
                <div class="stat-value" style="font-size:var(--font-xl)">${tm.calls_today || 0}</div>
                <div class="text-muted" style="font-size:var(--font-xs)">Today</div>
              </div>
              <div>
                <div class="stat-value" style="font-size:var(--font-xl)">${tm.calls_total || 0}</div>
                <div class="text-muted" style="font-size:var(--font-xs)">Total</div>
              </div>
            </div>
            <div class="flex gap-2" style="margin-top:var(--space-3)">
              <button class="btn btn-ghost btn-sm flex-1" data-edit-team="${tm.id}" data-name="${tm.name}" data-phone="${tm.phone || ''}" data-email="${tm.email || ''}">Edit</button>
              <button class="btn btn-ghost btn-sm" data-toggle-team="${tm.id}" data-active="${tm.is_active}" style="color:${tm.is_active ? 'var(--color-danger)' : 'var(--color-success)'}">${tm.is_active ? 'Deactivate' : 'Activate'}</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Edit handlers
    content.querySelectorAll('[data-edit-team]').forEach(btn => {
      btn.addEventListener('click', () => showEditTeamMemberModal(btn.dataset.editTeam, btn.dataset.name, btn.dataset.phone, btn.dataset.email));
    });

    // Toggle handlers
    content.querySelectorAll('[data-toggle-team]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newStatus = btn.dataset.active !== 'true';
        try {
          await sb.from('team_members').update({ is_active: newStatus, updated_at: new Date().toISOString() }).eq('id', btn.dataset.toggleTeam);
          showToast(`Team member ${newStatus ? 'activated' : 'deactivated'}`, 'success');
          loadTeamMembers();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
  } catch (err) {
    console.error('Load team error:', err);
    showToast('Failed to load team members', 'error');
  }
}

function showAddTeamMemberModal() {
  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <form id="add-team-form">
      <div class="form-group">
        <label class="form-label">Name <span class="required">*</span></label>
        <input class="form-input" id="tm-name" placeholder="Full name" required />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Phone</label>
          <input class="form-input" id="tm-phone" placeholder="10-digit number" />
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" id="tm-email" type="email" placeholder="email@example.com" />
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="document.querySelector('.modal-overlay')?.click()">Cancel</button>
        <button type="submit" class="btn btn-primary">Add Member</button>
      </div>
    </form>
  `;

  showModal({ title: 'Add Team Member', content: formContent });

  formContent.querySelector('#add-team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = formContent.querySelector('#tm-name').value.trim();
    const phone = formContent.querySelector('#tm-phone').value.trim() || null;
    const email = formContent.querySelector('#tm-email').value.trim() || null;

    if (!name) { showToast('Name is required', 'warning'); return; }

    try {
      const sb = getSupabase();
      await sb.from('team_members').insert({ name, phone, email });
      showToast(`${name} added to team!`, 'success');
      closeModal();
      loadTeamMembers();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function showEditTeamMemberModal(id, name, phone, email) {
  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <form id="edit-team-form">
      <div class="form-group">
        <label class="form-label">Name <span class="required">*</span></label>
        <input class="form-input" id="tm-edit-name" value="${sanitize(name)}" required />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Phone</label>
          <input class="form-input" id="tm-edit-phone" value="${sanitize(phone)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" id="tm-edit-email" type="email" value="${sanitize(email)}" />
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="document.querySelector('.modal-overlay')?.click()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;

  showModal({ title: 'Edit Team Member', content: formContent });

  formContent.querySelector('#edit-team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const sb = getSupabase();
      await sb.from('team_members').update({
        name: formContent.querySelector('#tm-edit-name').value.trim(),
        phone: formContent.querySelector('#tm-edit-phone').value.trim() || null,
        email: formContent.querySelector('#tm-edit-email').value.trim() || null,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      showToast('Team member updated', 'success');
      closeModal();
      loadTeamMembers();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

async function bulkAddToQueue() {
  const sb = getSupabase();
  const btn = document.getElementById('bulk-queue-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block"></div> Adding...';

  try {
    // Get all active patients not already in pending queue
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

    // Insert in batches of 50
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50);
      await sb.from('call_queue').insert(batch);
    }

    showToast(`${toAdd.length} patients added to call queue!`, 'success');
    
    // Switch to queue tab
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

    // Group by status
    const statusGroups = { pending: [], in_progress: [], callback: [], completed: [], skipped: [] };
    data.forEach(q => {
      (statusGroups[q.status] || statusGroups.pending).push(q);
    });

    const statusColors = { pending: 'warning', in_progress: 'info', callback: 'primary', completed: 'success', skipped: 'danger' };

    content.innerHTML = `
      <div class="flex gap-4 mb-4" style="flex-wrap:wrap">
        ${Object.entries(statusGroups).map(([status, items]) => `
          <div class="card" style="min-width:120px;text-align:center;padding:var(--space-3)">
            <div class="stat-value">${items.length}</div>
            <span class="badge badge-${statusColors[status] || 'neutral'}">${capitalize(status.replace('_', ' '))}</span>
          </div>
        `).join('')}
      </div>
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
                <td><span class="badge badge-${statusColors[q.status] || 'neutral'} badge-dot">${capitalize(q.status.replace('_', ' '))}</span></td>
                <td>${q.team_members?.name || '—'}</td>
                <td>${q.attempts}/${q.max_attempts}</td>
                <td><span class="badge badge-${q.priority === 'high' ? 'danger' : q.priority === 'low' ? 'neutral' : 'warning'}">${capitalize(q.priority)}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Clear completed
    document.getElementById('clear-completed-btn')?.addEventListener('click', async () => {
      try {
        await sb.from('call_queue').delete().eq('status', 'completed');
        showToast('Completed entries cleared', 'success');
        loadQueue();
      } catch (err) { showToast(err.message, 'error'); }
    });

    // Reset skipped
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
