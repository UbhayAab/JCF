// ============================================================
// Patient Navigator: Chart.js Utility Module
// Wraps Chart.js for consistent, theme-following charts
// ============================================================

// Canvas can't read CSS var() strings, so pull token values off :root at call time.
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Color palette for charts: v11 "Cocoa & Blush". The mockups' "Calls Over
// Time" draws Total in blue and Connected in green on white, so the series
// lead with those two, then the pastel tile family at full strength.
// These stay rgba(…, 1) literals because callers derive translucent fills via
// `.replace('1)', '0.x)')` and createGradient's `/[\d.]+\)$/` regex.
export const CHART_COLORS = {
  primary:   'rgba(74, 112, 214, 1)',   // blue: "Total" in the mockups
  accent:    'rgba(214, 74, 128, 1)',   // blush
  rose:      'rgba(186, 26, 26, 1)',    // danger red
  success:   'rgba(46, 150, 110, 1)',   // green: "Connected" in the mockups
  warning:   'rgba(196, 128, 18, 1)',   // amber
  info:      'rgba(26, 67, 168, 1)',    // deep blue
  danger:    'rgba(186, 26, 26, 1)',
  slate:     'rgba(110, 98, 95, 1)',    // warm stone
};

export const CHART_PALETTE = [
  'rgba(74, 112, 214, 0.85)',  // blue
  'rgba(214, 74, 128, 0.85)',  // blush
  'rgba(46, 150, 110, 0.85)',  // green
  'rgba(196, 128, 18, 0.85)',  // amber
  'rgba(110, 82, 190, 0.85)',  // lavender
  'rgba(24, 130, 170, 0.85)',  // cyan
  'rgba(200, 70, 60, 0.85)',   // rose
  'rgba(150, 96, 66, 0.85)',   // cocoa
  'rgba(92, 170, 140, 0.85)',  // mint
  'rgba(110, 98, 95, 0.85)',   // stone
];

export const CHART_PALETTE_LIGHT = [
  'rgba(74, 112, 214, 0.16)',
  'rgba(214, 74, 128, 0.16)',
  'rgba(46, 150, 110, 0.16)',
  'rgba(196, 128, 18, 0.16)',
  'rgba(110, 82, 190, 0.16)',
  'rgba(24, 130, 170, 0.16)',
  'rgba(200, 70, 60, 0.16)',
  'rgba(150, 96, 66, 0.16)',
  'rgba(92, 170, 140, 0.16)',
  'rgba(110, 98, 95, 0.16)',
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
          color: cssVar('--ink-2'),
          font: { family: "'Manrope', sans-serif", size: 11 },
          padding: 16,
          usePointStyle: true,
          pointStyleWidth: 8,
        },
      },
      tooltip: {
        backgroundColor: cssVar('--surface'),
        titleColor: cssVar('--ink'),
        bodyColor: cssVar('--ink-2'),
        borderColor: cssVar('--line'),
        borderWidth: 1,
        cornerRadius: 9,
        padding: 12,
        titleFont: { family: "'Manrope', sans-serif", weight: '600', size: 13 },
        bodyFont: { family: "'Manrope', sans-serif", size: 11.5 },
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
          color: cssVar('--line'),
          drawBorder: false,
        },
        ticks: {
          color: cssVar('--ink-2'),
          font: { family: "'Manrope', sans-serif", size: 10 },
          maxRotation: 45,
        },
        border: { display: false },
      },
      y: {
        grid: {
          color: cssVar('--line'),
          drawBorder: false,
        },
        ticks: {
          color: cssVar('--ink-2'),
          font: { family: "'Manrope', sans-serif", size: 10 },
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

// The live Chart instance, so callers can read back what is on screen
// (used by the per-chart CSV download on the analytics page).
export function getChart(canvasId) { return chartInstances[canvasId] || null; }

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

// ---- Follow the theme ----
// cssVar() is read ONCE, when a chart is constructed, so every axis label,
// gridline and legend kept the colours of whichever theme happened to be
// active at build time. Switching to dark left the tick glyphs at 1.40:1 on
// the new ground, and no amount of resizing fixed it: the options object was
// stale, not the raster. js/theme.js has dispatched a `themechange` event
// since it was written and nothing ever listened.
//
// Re-derive the option defaults and merge them over each live chart. Only the
// colour-bearing scale and plugin options are touched, so a caller's own
// options survive. update('none') repaints without replaying the entry
// animation, which would be a strange thing to see on a theme toggle.
function repaintChartsForTheme() {
  Object.values(chartInstances).forEach(chart => {
    if (!chart || !chart.options) return;
    try {
      const fresh = defaultChartOptions(chart.config?.type);
      const tick = fresh?.scales?.x?.ticks?.color;
      const grid = fresh?.scales?.y?.grid?.color;
      ['x', 'y'].forEach(axis => {
        const s = chart.options.scales?.[axis];
        if (!s) return;
        if (s.ticks && tick) s.ticks.color = tick;
        if (s.grid && grid) s.grid.color = grid;
        if (s.title && tick) s.title.color = tick;
      });
      const legend = chart.options.plugins?.legend?.labels;
      if (legend && tick) legend.color = tick;
      const tip = fresh?.plugins?.tooltip;
      if (tip && chart.options.plugins?.tooltip) {
        Object.assign(chart.options.plugins.tooltip, tip);
      }
      chart.update('none');
    } catch { /* one bad chart must not stop the rest repainting */ }
  });
}

if (typeof window !== 'undefined' && !window.__chartThemeBound) {
  window.__chartThemeBound = true;
  window.addEventListener('themechange', repaintChartsForTheme);
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
