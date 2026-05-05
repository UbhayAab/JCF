// ============================================================
// Patient Navigator — Chart.js Utility Module
// Wraps Chart.js for consistent dark-themed charts
// ============================================================

// Color palette for charts
export const CHART_COLORS = {
  primary:   'rgba(6, 182, 212, 1)',
  accent:    'rgba(139, 92, 246, 1)',
  rose:      'rgba(244, 63, 94, 1)',
  success:   'rgba(16, 185, 129, 1)',
  warning:   'rgba(245, 158, 11, 1)',
  info:      'rgba(59, 130, 246, 1)',
  danger:    'rgba(239, 68, 68, 1)',
  slate:     'rgba(148, 163, 184, 1)',
};

export const CHART_PALETTE = [
  'rgba(6, 182, 212, 0.85)',
  'rgba(139, 92, 246, 0.85)',
  'rgba(244, 63, 94, 0.85)',
  'rgba(16, 185, 129, 0.85)',
  'rgba(245, 158, 11, 0.85)',
  'rgba(59, 130, 246, 0.85)',
  'rgba(239, 68, 68, 0.85)',
  'rgba(167, 139, 250, 0.85)',
  'rgba(251, 113, 133, 0.85)',
  'rgba(34, 211, 238, 0.85)',
];

export const CHART_PALETTE_LIGHT = [
  'rgba(6, 182, 212, 0.15)',
  'rgba(139, 92, 246, 0.15)',
  'rgba(244, 63, 94, 0.15)',
  'rgba(16, 185, 129, 0.15)',
  'rgba(245, 158, 11, 0.15)',
  'rgba(59, 130, 246, 0.15)',
  'rgba(239, 68, 68, 0.15)',
  'rgba(167, 139, 250, 0.15)',
  'rgba(251, 113, 133, 0.15)',
  'rgba(34, 211, 238, 0.15)',
];

// Chart instance registry (for cleanup)
const chartInstances = {};

// Default chart options for dark theme
export function defaultChartOptions(type = 'bar') {
  const base = {
    responsive: true,
    maintainAspectRatio: true,
    animation: {
      duration: 800,
      easing: 'easeOutQuart',
    },
    plugins: {
      legend: {
        display: false,
        labels: {
          color: 'rgba(148, 163, 184, 0.8)',
          font: { family: "'Inter', sans-serif", size: 11 },
          padding: 16,
          usePointStyle: true,
          pointStyleWidth: 8,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(14, 21, 38, 0.95)',
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(148, 163, 184, 0.15)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 12,
        titleFont: { family: "'Inter', sans-serif", weight: '600', size: 13 },
        bodyFont: { family: "'Inter', sans-serif", size: 12 },
        displayColors: true,
        boxPadding: 4,
      },
    },
    scales: {},
  };

  if (['bar', 'line'].includes(type)) {
    base.scales = {
      x: {
        grid: {
          color: 'rgba(148, 163, 184, 0.04)',
          drawBorder: false,
        },
        ticks: {
          color: 'rgba(148, 163, 184, 0.6)',
          font: { family: "'Inter', sans-serif", size: 11 },
          maxRotation: 45,
        },
        border: { display: false },
      },
      y: {
        grid: {
          color: 'rgba(148, 163, 184, 0.04)',
          drawBorder: false,
        },
        ticks: {
          color: 'rgba(148, 163, 184, 0.6)',
          font: { family: "'Inter', sans-serif", size: 11 },
          precision: 0,
        },
        border: { display: false },
        beginAtZero: true,
      },
    };
  }

  return base;
}

// Create or update a chart
export function createChart(canvasId, type, data, customOptions = {}) {
  // Destroy existing instance
  destroyChart(canvasId);

  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.warn(`Canvas #${canvasId} not found`);
    return null;
  }

  const ctx = canvas.getContext('2d');
  const options = defaultChartOptions(type);

  // Deep merge custom options
  const merged = deepMerge(options, customOptions);

  const chart = new Chart(ctx, { type, data, options: merged });
  chartInstances[canvasId] = chart;
  return chart;
}

// Destroy a chart instance
export function destroyChart(canvasId) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
    delete chartInstances[canvasId];
  }
}

// Destroy all charts
export function destroyAllCharts() {
  Object.keys(chartInstances).forEach(destroyChart);
}

// Create gradient fill for area charts
export function createGradient(ctx, color, height = 200) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, color.replace(/[\d.]+\)$/, '0.3)'));
  gradient.addColorStop(1, color.replace(/[\d.]+\)$/, '0.02)'));
  return gradient;
}

// Helper: deep merge objects
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Format number with K/M suffix
export function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}
