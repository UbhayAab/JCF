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
            <div class="card-title">Upcoming Follow-ups</div>
          </div>
          <div id="upcoming-followups">${Array(4).fill('<div class="skeleton skeleton-row"></div>').join('')}</div>
        </div>
      </div>
    </div>
  `;

  // Quick action handlers
  document.getElementById('qa-register-patient')?.addEventListener('click', () => navigate('patients'));
  document.getElementById('qa-log-call')?.addEventListener('click', () => navigate('calls'));
  document.getElementById('qa-analytics')?.addEventListener('click', () => navigate('analytics'));
  document.getElementById('view-all-calls')?.addEventListener('click', () => navigate('calls'));

  await Promise.all([loadStats(), loadRecentCalls(), loadFollowUps()]);
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

async function loadFollowUps() {
  const sb = getSupabase();
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await sb
      .from('call_logs')
      .select('*, patients(patient_code, full_name)')
      .gte('follow_up_date', today)
      .order('follow_up_date', { ascending: true })
      .limit(8);

    if (error) throw error;
    const el = document.getElementById('upcoming-followups');
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:var(--space-8)"><p>No upcoming follow-ups</p></div>';
      return;
    }

    el.innerHTML = data.map(c => `
      <div class="flex items-center gap-4" style="padding:var(--space-3) 0; border-bottom:1px solid var(--glass-border)">
        <div class="flex-1">
          <div class="font-medium text-primary">${c.patients?.full_name || c.patients?.patient_code || '—'}</div>
          <div class="text-muted" style="font-size:var(--font-xs)">${formatDate(c.follow_up_date)}</div>
        </div>
        <span class="badge badge-${c.follow_up_priority === 'high' ? 'danger' : c.follow_up_priority === 'medium' ? 'warning' : 'info'} badge-dot">${capitalize(c.follow_up_priority)}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Follow-ups error:', err);
  }
}
