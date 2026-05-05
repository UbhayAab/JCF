// ============================================================
// Patient Navigator — Analytics Page
// Interactive charts powered by Chart.js
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin, getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { capitalize } from '../utils/formatters.js';
import {
  createChart, destroyAllCharts,
  CHART_PALETTE, CHART_PALETTE_LIGHT, CHART_COLORS,
  defaultChartOptions, createGradient
} from '../utils/charts.js';

let currentRange = 30;

export async function renderAnalytics(container) {
  const role = getUserRole();
  if (!['admin', 'manager', 'content'].includes(role)) {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Analytics is available for admin, manager, and content roles.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Analytics</h1>
        <p class="header-subtitle" style="margin:0">Data insights and performance metrics</p>
      </div>
      <div class="flex gap-2">
        <select class="form-select" id="analytics-range" style="width:auto;min-width:140px">
          <option value="7">Last 7 Days</option>
          <option value="30" selected>Last 30 Days</option>
          <option value="90">Last 90 Days</option>
          <option value="365">All Time</option>
        </select>
      </div>
    </div>

    <!-- Summary Stats -->
    <div class="stats-grid" id="analytics-stats">
      ${Array(4).fill('<div class="card stat-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>').join('')}
    </div>

    <!-- Charts Grid -->
    <div class="chart-grid" id="analytics-charts">
      <!-- Row 1: Calls Timeline (full width) -->
      <div class="chart-card chart-full-width animate-fade-in">
        <div class="chart-header">
          <div class="chart-title">Calls Over Time</div>
          <div class="flex gap-2">
            <span class="badge badge-primary badge-dot">Total Calls</span>
            <span class="badge badge-success badge-dot">Connected</span>
          </div>
        </div>
        <canvas id="chart-calls-timeline" height="100"></canvas>
      </div>

      <!-- Row 2: Cancer Type + Stage -->
      <div class="chart-card animate-fade-in" style="animation-delay:100ms">
        <div class="chart-header">
          <div class="chart-title">Cancer Type Distribution</div>
        </div>
        <canvas id="chart-cancer-types"></canvas>
      </div>
      <div class="chart-card animate-fade-in" style="animation-delay:150ms">
        <div class="chart-header">
          <div class="chart-title">Stage Distribution</div>
        </div>
        <canvas id="chart-stages"></canvas>
      </div>

      <!-- Row 3: Mindset + Lead Sources -->
      <div class="chart-card animate-fade-in" style="animation-delay:200ms">
        <div class="chart-header">
          <div class="chart-title">Patient Mindset</div>
        </div>
        <canvas id="chart-mindset"></canvas>
      </div>
      <div class="chart-card animate-fade-in" style="animation-delay:250ms">
        <div class="chart-header">
          <div class="chart-title">Lead Sources</div>
        </div>
        <canvas id="chart-lead-sources"></canvas>
      </div>

      <!-- Row 4: Conversion Trend (full width) -->
      <div class="chart-card chart-full-width animate-fade-in" style="animation-delay:300ms">
        <div class="chart-header">
          <div class="chart-title">Conversion Score Trend</div>
          <span class="badge badge-primary">Weekly Average</span>
        </div>
        <canvas id="chart-score-trend" height="100"></canvas>
      </div>

      <!-- Row 5: Caller Performance + Geographic -->
      <div class="chart-card animate-fade-in" style="animation-delay:350ms">
        <div class="chart-header">
          <div class="chart-title">Caller Performance</div>
        </div>
        <canvas id="chart-caller-perf"></canvas>
      </div>
      <div class="chart-card animate-fade-in" style="animation-delay:400ms">
        <div class="chart-header">
          <div class="chart-title">Geographic Distribution</div>
        </div>
        <canvas id="chart-geographic"></canvas>
      </div>
    </div>
  `;

  document.getElementById('analytics-range')?.addEventListener('change', (e) => {
    currentRange = parseInt(e.target.value);
    loadAllCharts();
  });

  await loadAllCharts();
}

async function loadAllCharts() {
  destroyAllCharts();
  await Promise.all([
    loadSummaryStats(),
    loadCallsTimeline(),
    loadCancerDistribution(),
    loadStageDistribution(),
    loadMindsetBreakdown(),
    loadLeadSources(),
    loadScoreTrend(),
    loadCallerPerformance(),
    loadGeographic(),
  ]);
}

async function loadSummaryStats() {
  const sb = getSupabase();
  try {
    const { data } = await sb.rpc('get_dashboard_stats');
    const stats = data || {};
    document.getElementById('analytics-stats').innerHTML = `
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
            <div class="stat-value">${stats.total_calls_week || 0}</div>
            <div class="stat-label">Calls This Week</div>
          </div>
          <div class="stat-icon" style="background:rgba(59,130,246,0.08);color:var(--color-info);border-color:rgba(59,130,246,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/></svg>
          </div>
        </div>
      </div>
      <div class="card stat-card animate-fade-in" style="animation-delay:100ms">
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
      <div class="card stat-card animate-fade-in" style="animation-delay:150ms">
        <div class="flex justify-between items-center">
          <div>
            <div class="stat-value">${stats.avg_conversion_score || 0}</div>
            <div class="stat-label">Avg. Conversion Score</div>
          </div>
          <div class="stat-icon" style="background:rgba(139,92,246,0.08);color:var(--color-accent-400);border-color:rgba(139,92,246,0.1)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('Analytics stats error:', err);
  }
}

async function loadCallsTimeline() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_calls_timeline', { days_back: currentRange });
    if (error) throw error;
    if (!data || data.length === 0) return;

    const labels = data.map(d => {
      const date = new Date(d.date);
      return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    });

    const canvas = document.getElementById('chart-calls-timeline');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    createChart('chart-calls-timeline', 'line', {
      labels,
      datasets: [
        {
          label: 'Total Calls',
          data: data.map(d => d.total_calls),
          borderColor: CHART_COLORS.primary,
          backgroundColor: createGradient(ctx, CHART_COLORS.primary, 250),
          fill: true,
          tension: 0.4,
          pointRadius: 2,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
        {
          label: 'Connected',
          data: data.map(d => d.connected_calls),
          borderColor: CHART_COLORS.success,
          backgroundColor: createGradient(ctx, CHART_COLORS.success, 250),
          fill: true,
          tension: 0.4,
          pointRadius: 2,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
      ],
    }, {
      plugins: { legend: { display: false } },
      interaction: { mode: 'index', intersect: false },
    });
  } catch (err) { console.error('Calls timeline error:', err); }
}

async function loadCancerDistribution() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_cancer_distribution');
    if (error) throw error;
    if (!data || data.length === 0) return;

    createChart('chart-cancer-types', 'doughnut', {
      labels: data.map(d => d.cancer_type),
      datasets: [{
        data: data.map(d => d.patient_count),
        backgroundColor: CHART_PALETTE.slice(0, data.length),
        borderColor: 'rgba(6, 9, 15, 0.8)',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    }, {
      plugins: {
        legend: {
          display: true,
          position: 'right',
          labels: { boxWidth: 10, padding: 8, font: { size: 11 } }
        }
      },
      cutout: '65%',
    });
  } catch (err) { console.error('Cancer distribution error:', err); }
}

async function loadStageDistribution() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_stage_distribution');
    if (error) throw error;
    if (!data || data.length === 0) return;

    const stageLabels = {
      stage_i: 'Stage I', stage_ii: 'Stage II', stage_iii: 'Stage III',
      stage_iv: 'Stage IV', unknown: 'Unknown', not_applicable: 'N/A'
    };

    createChart('chart-stages', 'pie', {
      labels: data.map(d => stageLabels[d.stage] || d.stage),
      datasets: [{
        data: data.map(d => d.patient_count),
        backgroundColor: [
          CHART_COLORS.success,
          CHART_COLORS.info,
          CHART_COLORS.warning,
          CHART_COLORS.danger,
          CHART_COLORS.slate,
          'rgba(100,116,139,0.4)',
        ],
        borderColor: 'rgba(6, 9, 15, 0.8)',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    }, {
      plugins: {
        legend: {
          display: true,
          position: 'right',
          labels: { boxWidth: 10, padding: 8, font: { size: 11 } }
        }
      },
    });
  } catch (err) { console.error('Stage distribution error:', err); }
}

async function loadMindsetBreakdown() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_mindset_breakdown');
    if (error) throw error;
    if (!data || data.length === 0) return;

    const mindsetColors = {
      hopeful: CHART_COLORS.success,
      anxious: CHART_COLORS.warning,
      resistant: CHART_COLORS.danger,
      neutral: CHART_COLORS.slate,
      distressed: CHART_COLORS.rose,
      informed: CHART_COLORS.info,
      grateful: CHART_COLORS.primary,
    };

    createChart('chart-mindset', 'bar', {
      labels: data.map(d => capitalize(d.mindset)),
      datasets: [{
        data: data.map(d => d.call_count),
        backgroundColor: data.map(d => (mindsetColors[d.mindset] || CHART_COLORS.slate).replace('1)', '0.7)')),
        borderColor: data.map(d => mindsetColors[d.mindset] || CHART_COLORS.slate),
        borderWidth: 1,
        borderRadius: 6,
        maxBarThickness: 40,
      }],
    }, {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
    });
  } catch (err) { console.error('Mindset breakdown error:', err); }
}

async function loadLeadSources() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_lead_sources');
    if (error) throw error;
    if (!data || data.length === 0) return;

    const sourceLabels = {
      website: 'Website', referral: 'Referral', hospital_partner: 'Hospital',
      social_media: 'Social Media', whatsapp: 'WhatsApp', helpline: 'Helpline',
      camp: 'Camp', ngo_partner: 'NGO Partner', other: 'Other'
    };

    createChart('chart-lead-sources', 'bar', {
      labels: data.map(d => sourceLabels[d.source] || capitalize(d.source)),
      datasets: [{
        data: data.map(d => d.call_count),
        backgroundColor: CHART_PALETTE.slice(0, data.length).map(c => c.replace('0.85)', '0.6)')),
        borderColor: CHART_PALETTE.slice(0, data.length),
        borderWidth: 1,
        borderRadius: 6,
        maxBarThickness: 40,
      }],
    }, {
      plugins: { legend: { display: false } },
    });
  } catch (err) { console.error('Lead sources error:', err); }
}

async function loadScoreTrend() {
  const sb = getSupabase();
  try {
    const weeks = Math.ceil(currentRange / 7);
    const { data, error } = await sb.rpc('get_analytics_score_trend', { weeks_back: weeks });
    if (error) throw error;
    if (!data || data.length === 0) return;

    const canvas = document.getElementById('chart-score-trend');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    createChart('chart-score-trend', 'line', {
      labels: data.map(d => {
        const date = new Date(d.week_start);
        return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      }),
      datasets: [{
        label: 'Avg Score',
        data: data.map(d => d.avg_score),
        borderColor: CHART_COLORS.accent,
        backgroundColor: createGradient(ctx, CHART_COLORS.accent, 250),
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 7,
        borderWidth: 2.5,
        pointBackgroundColor: CHART_COLORS.accent,
      }],
    }, {
      plugins: { legend: { display: false } },
      scales: { y: { max: 10, min: 0 } },
    });
  } catch (err) { console.error('Score trend error:', err); }
}

async function loadCallerPerformance() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_caller_performance');
    if (error) throw error;
    if (!data || data.length === 0) return;

    createChart('chart-caller-perf', 'bar', {
      labels: data.map(d => d.caller_name?.split(' ')[0] || 'Unknown'),
      datasets: [
        {
          label: 'Total Calls',
          data: data.map(d => d.total_calls),
          backgroundColor: CHART_COLORS.primary.replace('1)', '0.6)'),
          borderColor: CHART_COLORS.primary,
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Connected',
          data: data.map(d => d.connected_calls),
          backgroundColor: CHART_COLORS.success.replace('1)', '0.6)'),
          borderColor: CHART_COLORS.success,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    }, {
      plugins: {
        legend: {
          display: true,
          labels: { boxWidth: 8, padding: 12, font: { size: 11 } }
        }
      },
    });
  } catch (err) { console.error('Caller performance error:', err); }
}

async function loadGeographic() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_geographic');
    if (error) throw error;
    if (!data || data.length === 0) return;

    createChart('chart-geographic', 'bar', {
      labels: data.map(d => d.state),
      datasets: [{
        data: data.map(d => d.patient_count),
        backgroundColor: CHART_PALETTE.slice(0, data.length).map(c => c.replace('0.85)', '0.5)')),
        borderColor: CHART_PALETTE.slice(0, data.length),
        borderWidth: 1,
        borderRadius: 6,
        maxBarThickness: 30,
      }],
    }, {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
    });
  } catch (err) { console.error('Geographic error:', err); }
}
