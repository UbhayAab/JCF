// ============================================================
// Patient Navigator — Dashboard Page v2
// Enhanced with 8 stat cards, quick actions, activity feed
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin, getUserRole } from '../auth.js';
import { formatDate, formatRelativeTime, getDialStatusBadge, renderScoreBar, capitalize } from '../utils/formatters.js';
import { showToast } from '../components/toast.js';
import { navigate } from '../router.js';

export async function renderDashboard(container) {
  const profile = getCurrentProfile();
  const isAdmin = isManagerOrAdmin();
  const greeting = getGreeting();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${greeting}, ${profile?.full_name?.split(' ')[0] || 'User'}</h1>
        <p class="header-subtitle" style="margin:0">Here's what's happening today</p>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="quick-actions mb-6">
      <button class="quick-action-btn" id="qa-register-patient">
        <div class="action-icon" style="background:rgba(6,182,212,0.1);color:var(--color-primary-400)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        </div>
        <div><div class="font-medium text-primary">Register Patient</div><div class="text-muted" style="font-size:var(--font-xs)">Add new patient</div></div>
      </button>
      <button class="quick-action-btn" id="qa-log-call">
        <div class="action-icon" style="background:rgba(59,130,246,0.1);color:var(--color-info)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/></svg>
        </div>
        <div><div class="font-medium text-primary">Log Call</div><div class="text-muted" style="font-size:var(--font-xs)">Record interaction</div></div>
      </button>
      ${isAdmin ? `
      <button class="quick-action-btn" id="qa-analytics">
        <div class="action-icon" style="background:rgba(139,92,246,0.1);color:var(--color-accent-400)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        </div>
        <div><div class="font-medium text-primary">Analytics</div><div class="text-muted" style="font-size:var(--font-xs)">View insights</div></div>
      </button>` : ''}
    </div>

    <!-- Stats Grid (8 cards) -->
    <div class="stats-grid" id="stats-grid">
      ${Array(8).fill('<div class="card stat-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>').join('')}
    </div>

    <!-- Content Grid -->
    <div class="content-grid">
      <div class="col-span-8">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Recent Call Logs</div>
            <button class="btn btn-ghost btn-sm" id="view-all-calls">View All →</button>
          </div>
          <div id="recent-calls">${Array(5).fill('<div class="skeleton skeleton-row"></div>').join('')}</div>
        </div>
      </div>
      <div class="col-span-4">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Calls Due Today</div>
            <button class="btn btn-ghost btn-sm" id="view-calling">Open Portal →</button>
          </div>
          <div id="due-today">${Array(4).fill('<div class="skeleton skeleton-row"></div>').join('')}</div>
        </div>

        ${isAdmin ? `
        <div class="card" style="margin-top:var(--space-4)">
          <div class="card-header">
            <div>
              <div class="card-title">Today's Intake</div>
              <div class="card-subtitle" id="intake-subtitle">Loading…</div>
            </div>
          </div>
          <div id="intake-summary"></div>
          <button class="btn btn-primary" id="distribute-btn" style="width:100%;margin-top:var(--space-3)">
            Distribute to Active Callers
          </button>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  // Quick action handlers
  document.getElementById('qa-register-patient')?.addEventListener('click', () => navigate('patients'));
  document.getElementById('qa-log-call')?.addEventListener('click', () => navigate('calls'));
  document.getElementById('qa-analytics')?.addEventListener('click', () => navigate('analytics'));
  document.getElementById('view-all-calls')?.addEventListener('click', () => navigate('calls'));
  document.getElementById('view-calling')?.addEventListener('click', () => navigate('calling'));
  document.getElementById('distribute-btn')?.addEventListener('click', distributeIntake);

  const tasks = [loadStats(), loadRecentCalls(), loadDueToday()];
  if (isAdmin) tasks.push(loadIntakeSummary());
  await Promise.all(tasks);
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

async function loadStats() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_dashboard_stats');
    if (error) throw error;

    const stats = data || {};
    const grid = document.getElementById('stats-grid');
    if (!grid) return;

    grid.innerHTML = `
      <div class="card stat-card animate-fade-in">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.total_patients || 0}</div>
            <div class="stat-label">Total Patients</div>
          </div>
          <div class="stat-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:50ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.total_calls_today || 0}</div>
            <div class="stat-label">Calls Today</div>
          </div>
          <div class="stat-icon" style="background:rgba(59,130,246,0.08);color:var(--color-info);border-color:rgba(59,130,246,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:100ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.connected_today || 0}</div>
            <div class="stat-label">Connected Today</div>
          </div>
          <div class="stat-icon" style="background:rgba(16,185,129,0.08);color:var(--color-success);border-color:rgba(16,185,129,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:150ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.avg_conversion_score || 0}</div>
            <div class="stat-label">Avg. Score</div>
          </div>
          <div class="stat-icon" style="background:rgba(139,92,246,0.08);color:var(--color-accent-400);border-color:rgba(139,92,246,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:200ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.patients_this_month || 0}</div>
            <div class="stat-label">New This Month</div>
          </div>
          <div class="stat-icon" style="background:rgba(244,63,94,0.08);color:var(--color-rose-400);border-color:rgba(244,63,94,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:250ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.consent_rate || 0}%</div>
            <div class="stat-label">Consent Rate</div>
          </div>
          <div class="stat-icon" style="background:rgba(16,185,129,0.08);color:var(--color-success);border-color:rgba(16,185,129,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:300ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.pending_follow_ups || 0}</div>
            <div class="stat-label">Pending Follow-ups</div>
          </div>
          <div class="stat-icon" style="background:rgba(245,158,11,0.08);color:var(--color-warning);border-color:rgba(245,158,11,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:350ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.pending_qa_reviews || 0}</div>
            <div class="stat-label">Pending QA</div>
          </div>
          <div class="stat-icon" style="background:rgba(59,130,246,0.08);color:var(--color-info);border-color:rgba(59,130,246,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('Dashboard stats error:', err);
    showToast('Failed to load dashboard stats', 'error');
  }
}

async function loadRecentCalls() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .from('call_logs')
      .select('*, patients(patient_code, full_name, cancer_type), profiles:caller_id(full_name)')
      .order('call_date', { ascending: false })
      .limit(8);

    if (error) throw error;
    const el = document.getElementById('recent-calls');
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML = '<div class="empty-state"><p>No call logs yet</p></div>';
      return;
    }

    el.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Patient</th><th>Status</th><th>Duration</th><th>Score</th><th>When</th>
        </tr></thead>
        <tbody>
          ${data.map(c => `
            <tr>
              <td><strong class="text-primary">${c.patients?.patient_code || '—'}</strong><br><small class="text-muted">${c.patients?.cancer_type || ''}</small></td>
              <td>${getDialStatusBadge(c.dial_status)}</td>
              <td>${c.call_duration_mins || 0} min</td>
              <td>${renderScoreBar(c.conversion_score)}</td>
              <td>${formatRelativeTime(c.call_date)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    console.error('Recent calls error:', err);
  }
}

// "Calls Due Today" — call_queue entries that are scheduled/callback and due now or earlier.
// RLS on call_queue is permissive for now, so admins see everything; callers see their own
// once we wire team_members.profile_id correctly.
async function loadDueToday() {
  const sb = getSupabase();
  try {
    const now = new Date().toISOString();
    const { data, error } = await sb
      .from('call_queue')
      .select('id, status, scheduled_for, priority, followup_strategy_notes, patients(full_name, patient_code, phone_full)')
      .in('status', ['scheduled', 'callback', 'pending'])
      .or(`scheduled_for.lte.${now},scheduled_for.is.null`)
      .order('priority', { ascending: true })
      .order('scheduled_for', { ascending: true, nullsFirst: false })
      .limit(8);

    if (error) throw error;
    const el = document.getElementById('due-today');
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:var(--space-6)"><p>Nothing due. Inbox zero.</p></div>';
      return;
    }

    el.innerHTML = data.map(q => {
      const due = q.scheduled_for ? formatRelativeTime(q.scheduled_for) : 'Pending';
      const priorityBadge = q.priority === 'high' ? 'danger' : q.priority === 'medium' ? 'warning' : 'info';
      return `
        <div class="flex items-center gap-3" style="padding:var(--space-3) 0;border-bottom:1px solid var(--glass-border)">
          <div class="flex-1" style="min-width:0">
            <div class="font-medium text-primary" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${q.patients?.full_name || q.patients?.patient_code || '—'}</div>
            <div class="text-muted" style="font-size:var(--font-xs)">${due}${q.status === 'callback' ? ' · Callback' : q.status === 'scheduled' ? ' · Follow-up' : ''}</div>
          </div>
          <span class="badge badge-${priorityBadge} badge-dot">${capitalize(q.priority || 'medium')}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Due-today error:', err);
    const el = document.getElementById('due-today');
    if (el) el.innerHTML = '<div class="empty-state" style="padding:var(--space-6)"><p class="text-muted">Could not load queue.</p></div>';
  }
}

// "Today's Intake" — patients added in the last 24h plus the count waiting for assignment.
async function loadIntakeSummary() {
  const sb = getSupabase();
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [{ count: newToday }, { count: unassigned }] = await Promise.all([
      sb.from('patients').select('*', { count: 'exact', head: true }).gte('created_at', since),
      sb.from('patients').select('*', { count: 'exact', head: true }).is('assigned_to', null).eq('do_not_call', false),
    ]);

    document.getElementById('intake-subtitle').textContent =
      `${newToday || 0} new in last 24h · ${unassigned || 0} unassigned`;

    const summaryEl = document.getElementById('intake-summary');
    if (!summaryEl) return;
    summaryEl.innerHTML = `
      <div class="flex gap-4" style="padding:var(--space-2) 0">
        <div style="flex:1">
          <div class="stat-value" style="font-size:var(--font-2xl)">${newToday || 0}</div>
          <div class="text-muted" style="font-size:var(--font-xs)">New (24h)</div>
        </div>
        <div style="flex:1">
          <div class="stat-value" style="font-size:var(--font-2xl);color:${unassigned > 0 ? 'var(--color-warning)' : 'var(--color-text-primary)'}">${unassigned || 0}</div>
          <div class="text-muted" style="font-size:var(--font-xs)">Unassigned</div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('Intake summary error:', err);
  }
}

// Admin button: triggers the load-balanced distribution RPC and refreshes counts.
async function distributeIntake() {
  const sb = getSupabase();
  const btn = document.getElementById('distribute-btn');
  if (!btn) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto"></div>';
  try {
    const { data, error } = await sb.rpc('distribute_new_patients');
    if (error) throw error;
    showToast(`Distributed ${data || 0} patients to active callers`, 'success');
    await loadIntakeSummary();
  } catch (err) {
    showToast('Distribution failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
