// ============================================================
// Patient Navigator: Analytics Page
//
// One shared cohort filter and one shared date range drive everything: a live
// written brief at the top, ~35 charts, and a one-line story under each one, so
// the page reads as findings first and graphs second.
//
// Filtering is the spine. Pick "Gastric, stage IV, no support yet" once and the
// whole page - every chart, every story, every download - describes exactly
// those patients. Clicking a bar or a slice adds that value as a filter, so you
// can drill from "who we reach" into one group without leaving the page.
// Auto-refreshes while open.
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin, getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { capitalize, exportToCSV } from '../utils/formatters.js';
import {
  giLabel, measureLabel, leverLabel, PATIENT_STATUSES, TRAJECTORIES, MEASURES,
  DIAL_STATUSES, concernReason, sessionKind,
} from '../utils/catalog.js';
import {
  mountAnalyticsFilters, getFilters, isFiltered, filterCount,
  cohortStats, filterSummary, crossFilter, valueLabel,
} from '../components/analyticsFilters.js';

const MEASURE_META = Object.fromEntries(MEASURES.map(m => [m.key, { max: m.max, dir: m.dir, label: m.label }]));
import {
  createChart, destroyAllCharts, getChart,
  CHART_PALETTE, CHART_PALETTE_LIGHT, CHART_COLORS,
  defaultChartOptions, createGradient
} from '../utils/charts.js';
import { initInstrumentTooltips, instrumentChip, metricTitle, metricTerm, METRIC_INFO } from '../utils/instruments.js';

// The active cohort filter, in the exact shape pf_ids() reads on the DB side.
// Every RPC on this page takes it, so no chart can quietly describe a different
// set of people than the one named in the bar at the top.
const F = () => getFilters();

// Analytics charts fill an explicit-height box (.chart-canvas-wrap) instead
// of deriving height from width. That's what stops axis labels and legends
// from colliding when a card is narrow or on a phone. Every chart here also
// gets sensible tick de-crowding so nothing overlaps.
function mkChart(canvasId, type, data, customOptions = {}) {
  const { filterOn, ...rest } = customOptions;
  const opts = { maintainAspectRatio: false, resizeDelay: 80, ...rest };
  // Auto-thin category ticks on bar/line so labels never stack on top of
  // each other (unless the caller already set their own tick rules).
  if (['bar', 'line'].includes(type)) {
    opts.scales = opts.scales || {};
    const horiz = opts.indexAxis === 'y';
    const catAxis = horiz ? 'y' : 'x';
    opts.scales[catAxis] = {
      ...(opts.scales[catAxis] || {}),
      ticks: { autoSkip: true, maxRotation: horiz ? 0 : 38, minRotation: 0,
               ...((opts.scales[catAxis] || {}).ticks || {}) },
    };
  }
  // Click a bar or a slice to filter the whole page by it. `filterOn.values`
  // runs parallel to the labels and holds the real facet value (the key the
  // database stores), never the pretty label.
  if (filterOn?.facet && Array.isArray(filterOn.values)) {
    opts.onClick = (_evt, els) => {
      const i = els?.[0]?.index;
      if (i == null) return;
      const v = filterOn.values[i];
      if (v != null && v !== '') crossFilter(filterOn.facet, String(v));
    };
    const canvas = document.getElementById(canvasId);
    if (canvas) {
      canvas.classList.add('clickable');
      canvas.title = `Click a ${type === 'bar' ? 'bar' : 'slice'} to filter the whole page by it`;
    }
    markClickable(canvasId, filterOn.facet);
  }
  return createChart(canvasId, type, data, opts);
}

// Tell the reader a chart is interactive, once per render.
function markClickable(canvasId, facet) {
  const header = document.getElementById(canvasId)?.closest('.chart-card')?.querySelector('.chart-header > div:last-child');
  if (!header || header.querySelector('.js-clickable')) return;
  header.insertAdjacentHTML('afterbegin',
    `<span class="badge js-clickable" style="opacity:.7" title="Click any bar or slice to filter every chart on this page by that ${FACET_WORD[facet] || 'value'}">click to filter</span>`);
}
const FACET_WORD = {
  cancer: 'cancer type', stage: 'stage', vuln: 'vulnerability band', trajectory: 'disease path',
  insurance: 'insurance status', state: 'state', age_band: 'age band', gender: 'gender',
  lang: 'language', status: 'lifecycle stage',
};

// ── Page state ───────────────────────────────────────────────
let currentRange = 30;        // 7 | 15 | 30 | 90 | 365
let firstLoad = true;         // charts animate only on the first paint
let refreshTimer = null;      // 60s live refresh, self-clears on route change
let leverView = 'grouped';    // support-levers chart: 'grouped' families | 'detailed' per lever
let paintLevers = null;       // latest levers repaint fn, so the toggle never uses stale data
const RANGES = [
  { days: 7, label: '7 days' },
  { days: 15, label: '15 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];
const P = {};                 // numbers each loader leaves behind for the section insights

// A reload fans out ~34 RPCs that each paint when they land. If a second reload
// starts while the first is in flight, the slower requests from the OLD cohort
// arrive last and overwrite the new numbers - the page then shows the previous
// filter's figures under the current filter's chips. Reloads are therefore
// queued: whichever was asked for last is the one left on screen.
let reloadChain = Promise.resolve();
let reloadSeq = 0;
function queueReload() {
  const mine = ++reloadSeq;
  setPill('refreshing');
  reloadChain = reloadChain.catch(() => {}).then(async () => {
    // If the user clicked three filters quickly, only the last one is worth
    // drawing; the ones in between are already out of date.
    if (mine !== reloadSeq) return;
    if (!document.getElementById('analytics-root')) return;
    const charts = document.getElementById('analytics-charts');
    if (charts) { destroyAllCharts(); charts.innerHTML = chartsScaffold(); }
    await loadAllCharts();
  });
  return reloadChain;
}

// The live pill doubles as the "is this number current?" light.
function setPill(state) {
  const pill = document.getElementById('live-pill');
  if (!pill) return;
  if (state === 'refreshing') {
    pill.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#B0780E;box-shadow:0 0 0 3px #B0780E22"></span>UPDATING…';
  } else {
    pill.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#2C7A52;box-shadow:0 0 0 3px #2C7A5222"></span>LIVE · updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }
}

// canvas id → metric glossary key, so every chart title is auto-explained
// (hover/tap/keyboard the title → what it is, how to read it, why it matters).
const CHART_METRIC = {
  'chart-intake': 'registry_growth', 'chart-cancer-types': 'gi_subtypes', 'chart-stages': 'stage_first_contact',
  'chart-vulnerability': 'vulnerability', 'chart-trajectory': 'trajectory', 'chart-financial': 'insurance_status',
  'chart-geographic': 'geography', 'chart-age': 'age_bands', 'chart-gender': 'gender_split', 'chart-language': 'languages',
  'chart-status-mix': 'lifecycle', 'chart-subtype-stage': 'subtype_stage', 'chart-completeness': 'data_completeness',
  'chart-calls-timeline': 'calls_over_time', 'chart-outcomes': 'dial_outcomes', 'chart-besttime': 'best_time',
  'chart-action-outcomes': 'support_levers', 'chart-financial-sources': 'financial_sources', 'chart-support-equity': 'support_equity',
  'chart-requirements': 'requirements', 'chart-journey': 'journey_funnel', 'chart-sessions': 'saturday_circles',
  'chart-pipeline': 'session_pipeline', 'chart-caller-perf': 'mentor_performance', 'chart-concerns': 'concern_reasons',
  'chart-nutrition-funnel': 'nutrition_funnel', 'chart-nutrition-must': 'must', 'chart-nutrition-team': 'nutrition_team',
  'chart-cohort-trend': 'cohort_wellbeing', 'chart-impact-trend': 'pooled_wellbeing', 'chart-impact-improve': 'improve_stable_decline',
  'chart-impact': 'baseline_latest', 'chart-fintox-economic': 'fintox_by_income', 'chart-activation': 'activation',
  'chart-dose-response': 'dose_response', 'chart-warming': 'warming_curve', 'chart-trust': 'trust_curve',
};

// Page-local glossary entries: the glossary itself lives in utils/instruments.js;
// these keys are only used on this page, so they register here.
METRIC_INFO.navigation_outcomes = {
  name: 'Navigation outcomes',
  what: 'Every registered patient sorted into the five standard navigation-outcome headings our reports use.',
  read: 'Each tile is one heading with its count and share of the whole registry. "Other" is new leads still waiting for their first conversation. This is the current status of everyone on file, all-time, NOT affected by the time-range control.',
  why: 'The five headings are how navigation programs report outcomes. One glance shows how many journeys are ongoing, lost, or closed, in the language a journal write-up needs.',
  formula: 'Mapped from each patient\'s live status: active → Ongoing navigation · inactive → Lost to follow-up · deceased → Deceased · new lead → Other. No status marks a completed navigation episode yet, so "Successfully completed" reads 0 while the program is ongoing.',
};
if (METRIC_INFO.support_levers) {
  METRIC_INFO.support_levers.read = 'Grouped view: one bar per family of related levers (Nutrition, Clinical trials, Financial help…), hover a bar for the per-lever breakdown. Detailed view: every lever as its own bar. Green = delivered, grey = declined or not needed.';
}

const fmtIN = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const rangeLabel = () => RANGES.find(r => r.days === currentRange)?.label || `${currentRange} days`;
// charts re-animate only on first paint; live refreshes swap data quietly
const liveAnim = () => firstLoad ? {} : { animation: false };

// ── Small builders ───────────────────────────────────────────
// Every key chart carries a one-line story written from its own numbers.
function storySlot(canvasId) {
  return `<div class="chart-story" id="story-${canvasId}" style="display:none;margin-top:10px;padding:9px 12px;border-left:3px solid var(--line-2);background:var(--surface-2);border-radius:0 var(--r-sm) var(--r-sm) 0;font-size:12.5px;line-height:1.5;color:var(--ink-2)"></div>`;
}
function setStory(canvasId, html) {
  const el = document.getElementById('story-' + canvasId);
  if (!el || !html) return;
  el.innerHTML = html;
  el.style.display = '';
}

// A chart card. scope: 'range' (obeys the selector) | 'snapshot' (current
// cohort) | custom text. Story slot included by default.
function chartCard(canvasId, title, { scope = 'range', badge = '', full = false, height = null, delay = 0, metric = null } = {}) {
  // Under a filter, "whole cohort" is a lie. Say which cohort instead.
  const filtered = isFiltered();
  const cohortWord = filtered
    ? `<span class="badge badge-primary" title="${escAttr(filterSummary())}">filtered cohort${cohortStats()?.matched != null ? ` · n=${fmtIN(cohortStats().matched)}` : ''}</span>`
    : `<span class="badge" style="opacity:.75" title="Every active patient we currently hold. This chart is a snapshot of the whole registry and is NOT affected by the time-range control.">whole cohort · not dated</span>`;
  const scopeBadge = scope === 'range'
    ? `<span class="badge badge-primary js-range-badge">last ${rangeLabel()}${filtered ? ' · filtered' : ''}</span>`
    : scope === 'snapshot'
      ? cohortWord
      : `<span class="badge" style="opacity:.75">${scope}${filtered ? ' · filtered' : ''}</span>`;
  const wrapSize = full ? '' : (scope === 'snapshot' ? ' short' : '');
  // The title itself is the definition target (hover/tap/keyboard → what the
  // metric is, how to read it, why it matters). Auto-keyed from the canvas id.
  const metricKey = metric || CHART_METRIC[canvasId];
  const titleHTML = metricKey ? metricTitle(metricKey, title) : `<div class="chart-title">${title}</div>`;
  return `
    <div class="chart-card ${full ? 'chart-full-width' : ''} animate-fade-in" ${delay ? `style="animation-delay:${delay}ms"` : ''}>
      <div class="chart-header">${titleHTML}
        <div class="flex gap-2" style="flex-wrap:wrap;justify-content:flex-end;align-items:center">${badge}${scopeBadge}${dlBtn(canvasId, title)}</div>
      </div>
      <div class="chart-canvas-wrap${wrapSize}"><canvas id="${canvasId}"></canvas></div>
      ${storySlot(canvasId)}
    </div>`;
}

const escAttr = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Every chart can be taken away as a spreadsheet, filters and all.
function dlBtn(canvasId, title) {
  return `<button class="af-mini js-chart-dl" data-canvas="${canvasId}" data-title="${escAttr(title)}"
    title="Download the numbers behind this chart as a CSV" style="padding:4px 7px">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
  </button>`;
}

// Read the live Chart.js instance back out and write it as rows. Works for any
// chart type, so no loader has to maintain a second copy of its own data.
function downloadChartData(canvasId, title) {
  const chart = getChart(canvasId);
  if (!chart) { showToast('That chart has no data yet', 'warning'); return; }
  const labels = chart.data.labels || [];
  const sets = (chart.data.datasets || []).filter(d => (d.data || []).some(v => v != null));
  if (!labels.length || !sets.length) { showToast('That chart has no data yet', 'warning'); return; }
  const rows = labels.map((lab, i) => {
    const r = { label: String(lab) };
    sets.forEach((ds, k) => { r['s' + k] = ds.data?.[i] ?? ''; });
    return r;
  });
  const cols = [{ label: title.replace(/[\u2014\u2013]/g, '-'), key: 'label' },
    ...sets.map((ds, k) => ({ label: ds.label || 'Value', key: 's' + k }))];
  const slug = canvasId.replace(/^chart-/, '').replace(/-/g, '_');
  exportToCSV(rows, isFiltered() ? `${slug}_filtered` : slug, cols);
  showToast(`Exported ${rows.length} rows${isFiltered() ? ' for the filtered cohort' : ''}`, 'success');
}

// Grouped ⇄ Detailed switch for the support-levers chart. Rendered by the
// scaffold (so range changes rebuild it with the right state); wired up in
// loadActionOutcomes.
function leverViewToggle() {
  const btn = (view, label, tip) => `<button class="lever-view-btn" data-view="${view}" title="${tip}"
    style="border:0;cursor:pointer;padding:5px 11px;font-family:var(--font-mono);font-size:10.5px;background:${leverView === view ? 'var(--ink)' : 'transparent'};color:${leverView === view ? 'var(--paper, #FFFDFA)' : 'var(--ink-2)'}">${label}</button>`;
  return `<span id="lever-view-toggle" role="group" aria-label="Support-levers view" style="display:inline-flex;border:1px solid var(--line-2);border-radius:8px;overflow:hidden">
    ${btn('grouped', 'Grouped', 'One bar per family of related levers: hover a bar for the per-lever breakdown')}
    ${btn('detailed', 'Detailed', 'Every lever as its own bar: nothing rolled up')}
  </span>`;
}

// Section divider + a slot for the section-level combined insight.
function sectionBand(tag, title, subtitle, color) {
  const id = tag.toLowerCase().replace(/[^a-z]/g, '');
  return `
    <div class="ria-band" id="band-${id}" style="display:flex;align-items:center;gap:16px;margin:38px 0 10px;scroll-margin-top:80px">
      <span style="font-family:var(--font-mono);font-weight:600;font-size:10.5px;letter-spacing:.24em;color:#fff;background:${color};padding:6px 12px 6px 14px;border-radius:6px;white-space:nowrap;box-shadow:var(--hi-dark),0 4px 12px ${color}44">${tag}</span>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-display);font-size:21px;font-weight:790;font-stretch:112%;letter-spacing:-0.025em;color:var(--ink);line-height:1.15">${title}</div>
        <div style="font-size:13px;color:var(--ink-3)">${subtitle}</div>
      </div>
      <div style="flex:2;height:1px;background:linear-gradient(90deg,${color}55,transparent)"></div>
    </div>
    <div id="insight-${id}" style="display:none;margin:0 0 16px;padding:11px 14px;border-radius:var(--r-sm);background:${color}0d;border:1px solid ${color}26;font-size:13px;line-height:1.55;color:var(--ink-2)"></div>`;
}
function setSectionInsight(id, html) {
  const el = document.getElementById('insight-' + id);
  if (!el || !html) return;
  el.innerHTML = `<span style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:.2em;color:var(--ink-3);display:block;margin-bottom:3px">WHAT THESE CHARTS SAY TOGETHER</span>${html}`;
  el.style.display = '';
}

// Delta chip vs the previous window. goodUp=false flips the colors
// (e.g. open concerns going up is bad).
function deltaChip(cur, prev, goodUp = true) {
  cur = Number(cur || 0); prev = Number(prev || 0);
  if (!prev) return '';
  const ch = Math.round(((cur - prev) / prev) * 100);
  if (!isFinite(ch)) return '';
  const up = ch > 0;
  const col = ch === 0 ? 'var(--ink-3)' : (up === goodUp) ? '#2C7A52' : '#953028';
  const arrow = ch === 0 ? '·' : up ? '▲' : '▼';
  return `<span title="vs previous ${rangeLabel()}" style="font-size:10.5px;font-weight:600;color:${col};font-family:var(--font-mono);white-space:nowrap">${arrow} ${Math.abs(ch)}%</span>`;
}

// ── Page ─────────────────────────────────────────────────────
export async function renderAnalytics(container) {
  const role = getUserRole();
  if (!['admin', 'manager', 'content'].includes(role)) {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Analytics is available for admin, manager, and content roles.</p></div>';
    return;
  }

  container.innerHTML = `
    <div id="analytics-root">
      <div class="page-header">
        <div>
          <h1>Analytics</h1>
          <p class="header-subtitle" style="margin:0">Live. The story updates as the team works</p>
        </div>
        <div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <a href="#report" class="btn btn-secondary btn-sm" title="Open the monthly impact report and download it as a PDF"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>Monthly report</a>
          <span id="live-pill" style="display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;color:var(--ink-3);padding:5px 10px;border:1px solid var(--line-2);border-radius:99px">
            <span style="width:7px;height:7px;border-radius:50%;background:#2C7A52;box-shadow:0 0 0 3px #2C7A5222"></span>
            LIVE · loading…
          </span>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
            <div id="range-control" style="display:inline-flex;border:1px solid var(--line-2);border-radius:9px;overflow:hidden">
              ${RANGES.map(r => `<button class="range-btn" data-days="${r.days}" style="border:0;cursor:pointer;padding:7px 13px;font-family:var(--font-mono);font-size:11.5px;background:${r.days === currentRange ? 'var(--ink)' : 'transparent'};color:${r.days === currentRange ? 'var(--paper, #FFFDFA)' : 'var(--ink-2)'}">${r.label}</button>`).join('')}
            </div>
            <span class="scope-note" title="The time range governs the dated time-series charts. Charts marked ‘whole cohort’ describe every patient we currently hold and are not date-filtered.">applies to time-series · ⓘ whole-cohort charts ignore it</span>
          </div>
        </div>
      </div>

      <!-- Jump nav: the upper-level view first, then dig in -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:var(--s4)">
        ${[['reach', 'REACH', '#7A4C00'], ['action', 'ACTION', '#006469'], ['safetynet', 'SAFETY NET', '#953028'], ['nutrition', 'NUTRITION', '#106841'], ['impact', 'IMPACT', '#5B4892'], ['correlate', 'CORRELATE', '#7A4C00']]
          .map(([id, label, color]) => `<button class="jump-btn" data-target="band-${id}" style="border:1px solid ${color}44;background:${color}0d;color:var(--ink-2);border-radius:99px;padding:4px 12px;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;cursor:pointer">${label}</button>`).join('')}
      </div>

      <!-- The cohort filter: this decides who every number below is about -->
      <div id="analytics-filters"></div>

      <!-- The live brief: read this before any chart -->
      <div class="card animate-fade-in" id="pulse-panel" style="margin-bottom:var(--s4);border-left:4px solid var(--primary)">
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.22em;color:var(--ink-3);margin-bottom:6px">THE BRIEF · <span class="js-range-caps">LAST ${rangeLabel().toUpperCase()}</span> · WRITTEN FROM THE LIVE NUMBERS</div>
        <div id="pulse-text" style="font-size:14px;line-height:1.7;color:var(--ink)">
          <div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text" style="width:80%"></div>
        </div>
      </div>

      <!-- Range-scoped KPI row with vs-previous-window movement -->
      <div class="stats-grid" id="pulse-kpis" style="margin-bottom:var(--s2)">
        ${Array(4).fill('<div class="card stat-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>').join('')}
      </div>

      <!-- All-time impact hero numbers -->
      <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.22em;color:var(--ink-3);margin:var(--s3) 0 8px">SINCE THE PROGRAM BEGAN</div>
      <div class="stats-grid" id="impact-headline" style="margin-bottom:var(--s4)">
        ${Array(4).fill('<div class="card stat-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>').join('')}
      </div>

      <div id="analytics-charts">${chartsScaffold()}</div>
    </div>
  `;

  // Range switch: rebuild the chart scaffold (badges/cards change), reload everything.
  container.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentRange = parseInt(btn.dataset.days);
      container.querySelectorAll('.range-btn').forEach(b => {
        const on = parseInt(b.dataset.days) === currentRange;
        b.style.background = on ? 'var(--ink)' : 'transparent';
        b.style.color = on ? 'var(--paper, #FFFDFA)' : 'var(--ink-2)';
      });
      document.querySelectorAll('.js-range-caps').forEach(el => el.textContent = `LAST ${rangeLabel().toUpperCase()}`);
      queueReload();
    });
  });

  container.querySelectorAll('.jump-btn').forEach(btn => {
    btn.addEventListener('click', () => document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: 'smooth' }));
  });

  // The cohort filter. Any change rebuilds the scaffold (scope badges say
  // "filtered cohort · n=" instead of "whole cohort") and reloads every chart,
  // so the page can never show a mix of filtered and unfiltered numbers.
  const filtersReady = mountAnalyticsFilters(container.querySelector('#analytics-filters'), {
    onChange: () => queueReload(),
  });

  // One delegated handler for every per-chart download button, so cards
  // rebuilt on a range or filter change stay wired.
  container.addEventListener('click', (e) => {
    const b = e.target.closest?.('.js-chart-dl');
    if (!b) return;
    downloadChartData(b.dataset.canvas, b.dataset.title);
  });
  wireRequirementDelegates(container);

  // Live: refresh every 3 min while the page is open and visible. A full
  // refresh rebuilds ~35 canvases, so keep the cadence gentle on weak devices.
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.getElementById('analytics-root')) { clearInterval(refreshTimer); refreshTimer = null; return; }
    if (document.hidden) return;
    queueReload();
  }, 180000);

  // Let the cohort line paint first; the charts are meaningless until you know
  // whose numbers they are. Never block the page on it if it is slow.
  await Promise.race([filtersReady, new Promise(r => setTimeout(r, 2500))]).catch(() => {});
  await loadAllCharts();
}

// The chart sections. Rebuilt on range change so cards/badges stay honest.
function chartsScaffold() {
  return `
    ${sectionBand('REACH', 'Who we reach', 'The people and clinical reality behind the numbers', '#7A4C00')}
    <div class="chart-grid">
      ${chartCard('chart-intake', 'Registry growth: new patients per day', { full: true, height: 90 })}
      ${chartCard('chart-cancer-types', 'GI cancer subtypes', { scope: 'snapshot' })}
      ${chartCard('chart-stages', 'Stage at our first contact', { scope: 'snapshot', delay: 60 })}
      ${chartCard('chart-vulnerability', 'Household vulnerability', { scope: 'snapshot', badge: '<span class="badge badge-warn">income · insurance · dependents · distance</span>', delay: 120 })}
      ${chartCard('chart-trajectory', 'Disease trajectory', { scope: 'snapshot', delay: 180 })}
      ${chartCard('chart-financial', 'Financial situation', { scope: 'snapshot', delay: 220 })}
      ${chartCard('chart-geographic', 'Where they are', { scope: 'snapshot', delay: 260 })}
      ${chartCard('chart-age', 'Age at registration', { scope: 'snapshot', delay: 280 })}
      ${chartCard('chart-gender', 'Gender (patient & primary caregiver)', { scope: 'snapshot', badge: '<span class="badge badge-info">who is cared for · who carries it</span>', delay: 290 })}
      ${chartCard('chart-language', 'Languages families speak', { scope: 'snapshot', delay: 300 })}
      ${chartCard('chart-status-mix', 'Patient lifecycle', { scope: 'snapshot', delay: 320 })}
      <div class="chart-card animate-fade-in" style="animation-delay:330ms">
        <div class="chart-header">${metricTitle('navigation_outcomes', 'Navigation outcomes')}
          <span class="badge" style="opacity:.75" title="Derived from each patient's CURRENT status: a whole-registry snapshot since the program began, NOT affected by the time-range control.">whole cohort · all-time</span>
        </div>
        <div id="nav-outcomes" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;padding:6px 0"></div>
        ${storySlot('nav-outcomes')}
      </div>
      ${chartCard('chart-subtype-stage', 'Stage spread within each GI subtype', { scope: 'snapshot', badge: '<span class="badge badge-info">cross-reference</span>', full: true, height: 90, delay: 340 })}
      ${chartCard('chart-completeness', 'What we know vs. what’s still vague', { scope: 'snapshot', badge: '<span class="badge badge-warn">caregiver mentors get prompted for the gaps</span>', full: true, height: 100, delay: 360 })}
    </div>

    ${sectionBand('ACTION', 'What we do', 'Every dial, every support lever, and how far the relationship travels', '#006469')}
    <div class="chart-grid">
      ${chartCard('chart-calls-timeline', 'Calls over time', { full: true, height: 100, badge: '<span class="badge badge-primary badge-dot">Total</span><span class="badge badge-success badge-dot">Connected</span>' })}
      ${chartCard('chart-outcomes', 'What happened to every dial', { delay: 40 })}
      ${chartCard('chart-besttime', 'When families pick up', { badge: '<span class="badge badge-info">connect rate by hour · IST</span>', delay: 80 })}
      ${chartCard('chart-action-outcomes', 'Support levers (delivered vs. declined)', { scope: 'snapshot', badge: leverViewToggle() + '<span class="badge badge-gold">ACTION funnel</span>', full: true, height: 90, delay: 120 })}
      ${chartCard('chart-financial-sources', 'Financial help: the sources & the conversion', { scope: 'snapshot', badge: '<span class="badge badge-gold">sent → availed · ₹ by source</span>', full: true, delay: 140 })}
      ${chartCard('chart-support-equity', 'Reaching the most vulnerable', { scope: 'snapshot', badge: '<span class="badge badge-info">avg levers by need</span>', delay: 160 })}
      ${requirementsCard()}
      ${chartCard('chart-journey', 'How far people travel with us', { scope: 'snapshot', delay: 240 })}
      ${chartCard('chart-sessions', 'Saturday circles', { scope: 'monthly · all time', delay: 280,
        // group_sessions records a session, not who attended, so there is no
        // patient to filter on. Say so instead of letting it look filtered.
        badge: '<span class="badge badge-gold">nutrition · well-being</span>' +
          (isFiltered() ? '<span class="badge badge-warn" title="Group sessions are logged as events without an attendee list, so this chart cannot be narrowed to a cohort. It always shows the whole program.">whole program · filter does not apply</span>' : '') })}
      ${chartCard('chart-pipeline', 'One-to-one sessions: the pipeline', { badge: '<span class="badge badge-info">invited → held</span>', delay: 320 })}
      ${chartCard('chart-caller-perf', 'Caregiver mentor performance', { full: true, height: 90, delay: 360 })}
    </div>

    ${sectionBand('SAFETY NET', 'Concerns we caught', 'Red flags stop living in people’s memories. This is the escalation queue as data', '#953028')}
    <div class="chart-grid">
      ${chartCard('chart-concerns', 'Why patients get flagged', { full: true, height: 90 })}
      <div class="chart-card animate-fade-in" style="animation-delay:60ms">
        <div class="chart-header">${metricTitle('concern_backlog', 'The open backlog')}<span class="badge badge-warn">needs a human today</span></div>
        <div id="concerns-backlog" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;padding:6px 0"></div>
        ${storySlot('concerns-backlog')}
      </div>
    </div>

    ${sectionBand('NUTRITION', 'The nutrition arm', 'From assignment to plans to malnutrition risk, and who on the team is carrying it', '#106841')}
    <div class="chart-grid">
      ${chartCard('chart-nutrition-funnel', 'From touched to fed', { scope: 'snapshot', badge: '<span class="badge badge-ok">nutrition funnel</span>' })}
      ${chartCard('chart-nutrition-must', 'MUST malnutrition risk', { scope: 'snapshot', badge: '<span class="badge badge-warn">latest score per patient</span>', delay: 60 })}
      ${chartCard('chart-nutrition-team', 'Nutrition team performance', { badge: '<span class="badge badge-info">check-ins · patients · 1:1s held</span>', full: true, height: 90, delay: 120 })}
    </div>

    ${sectionBand('IMPACT', 'The change we see', 'In oncology a STABLE score is a win. Quality of life holding up is the outcome', '#5B4892')}
    <div class="chart-grid">
      <div class="chart-card chart-full-width animate-fade-in">
        <div class="chart-header">
          ${metricTitle('cohort_wellbeing', 'Wellbeing by intake cohort: the honest trend')}
          <span class="badge badge-primary" title="Each line follows only the patients who registered in that month, so a rising line is the SAME people improving, not the average being pulled around as new (sicker-at-baseline) patients arrive.">same patients over time</span>
        </div>
        <p style="font-size:12.5px;color:var(--ink-3);margin:0 0 8px;line-height:1.5">Pick a month below to follow <strong>only the patients who joined then</strong>. This separates real improvement from the illusion created by adding new patients each month. Every score is normalised to a 0-100 index where <strong>higher = better</strong>.</p>
        <div class="cohort-chips" id="cohort-chips"></div>
        <div class="chart-canvas-wrap"><canvas id="chart-cohort-trend"></canvas></div>
        ${storySlot('chart-cohort-trend')}
      </div>
      ${chartCard('chart-impact-trend', 'Wellbeing over time (all patients pooled)', { scope: 'monthly · all time', badge: '<span class="badge badge-warn" title="This pools everyone, so it mixes cohorts. Use the cohort chart above to read real change.">pooled · mixes cohorts</span>', full: true, height: 100 })}
      ${chartCard('chart-impact-improve', 'Improved · stable · declined', { scope: 'snapshot', badge: '<span class="badge badge-ok">stable = quality of life holding</span>', full: true, height: 90, delay: 60 })}
      ${chartCard('chart-impact', 'Wellbeing impact (baseline vs latest)', { scope: 'snapshot', badge: '<span class="badge badge-primary">avg per measure</span>', full: true, height: 100, delay: 120 })}
      ${chartCard('chart-fintox-economic', 'Financial toxicity by income band', { scope: 'snapshot', badge: '<span class="badge badge-info">cross-reference</span>', delay: 160 })}
      ${chartCard('chart-activation', 'Patient activation', { scope: 'snapshot', badge: '<span class="badge badge-info">“I know what to do if…”</span>', delay: 200 })}
    </div>

    ${sectionBand('CORRELATE', 'What moves with what', 'Does the support, the trust, the time actually correlate with better lives', '#7A4C00')}
    <div class="chart-grid">
      ${chartCard('chart-dose-response', 'Support dose vs well-being', { scope: 'snapshot', badge: '<span class="badge badge-gold">levers received → trajectory</span>' })}
      ${chartCard('chart-warming', 'The warming curve', { scope: 'snapshot', badge: '<span class="badge badge-info">receptiveness by nth conversation</span>', delay: 60 })}
      ${chartCard('chart-trust', 'The trust curve', { scope: 'snapshot', badge: '<span class="badge badge-info">what families share as calls grow</span>', delay: 120 })}
    </div>
  `;
}


// Run thunks with a bounded number in flight. Each is already wrapped in its
// own try/catch, so one failure never stops the rest.
async function runPooled(tasks, limit = 6) {
  const queue = tasks.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try { await t(); } catch (e) { console.error('chart loader failed:', e); }
    }
  });
  await Promise.all(workers);
}

async function loadAllCharts() {
  destroyAllCharts();
  // Firing all ~34 queries at once used to blow Postgres' statement timeout:
  // they queue behind each other on a shared instance and the slowest ones get
  // cancelled, leaving blank charts. A pool of 6 keeps every query fast, costs
  // about a second of wall time, and is far kinder to a phone on 3G.
  await runPooled([
    () => loadPulse(),
    () => loadHeadline(),
    // REACH
    () => loadIntakeTrend(),
    () => loadCancerDistribution(),
    () => loadStageDistribution(),
    () => loadReachCohort(),
    () => loadFinancial(),
    () => loadGeographic(),
    () => loadDemographics(),
    () => loadGenderSplit(),
    () => loadStatusMix(),
    () => loadNavigationOutcomes(),
    () => loadCompleteness(),
    // ACTION
    () => loadCallsTimeline(),
    () => loadOutcomeMix(),
    () => loadActionOutcomes(),
    () => loadFinancialSources(),
    () => loadSupportEquity(),
    () => loadRequirements(),
    () => loadJourneyFunnel(),
    () => loadSessionsChart(),
    () => loadSessionsPipeline(),
    () => loadCallerPerformance(),
    () => loadCallQuality(),
    // SAFETY NET
    () => loadConcerns(),
    // NUTRITION
    () => loadNutritionSection(),
    // IMPACT
    () => loadCohortTrend(),
    () => loadImpactTrend(),
    () => loadImpactImprove(),
    () => loadImpactDeltas(),
    () => loadImpactCross(),
    // CORRELATE
    () => loadDoseResponse(),
    () => loadWarmingCurve(),
    () => loadTrustCurve(),
  ], 6);
  renderSectionInsights();
  initInstrumentTooltips();
  setPill('live');
  firstLoad = false;
}

// ── THE BRIEF: the executive summary written from live numbers ──
async function loadPulse() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_pulse', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    const d = data || {};
    if (d.error) return;
    const c = d.curr || {}, p = d.prev || {};
    P.pulse = d;

    // Narrative: sentence by sentence, only saying what the data supports.
    const connectPct = pct(c.connected, c.calls);
    const parts = [];
    // Never let the brief read as the whole program when a filter is on.
    if (isFiltered()) {
      const cs = cohortStats();
      parts.push(`<span style="display:block;margin-bottom:6px;padding:7px 10px;background:var(--primary-soft);border-radius:var(--r-sm);font-size:13px">` +
        `<strong>Reading a filtered cohort:</strong> ${escAttr(filterSummary())}` +
        `${cs?.matched != null ? ` · <strong>${fmtIN(cs.matched)} of ${fmtIN(cs.total)} patients</strong>` : ''}. ` +
        `Every number below describes only these people.</span>`);
    }
    parts.push(`In the last <strong>${rangeLabel()}</strong> the team made <strong>${fmtIN(c.calls)} calls</strong> and had <strong>${fmtIN(c.connected)} real conversations (${connectPct}%)</strong>, reaching <strong>${fmtIN(c.families_reached)} families</strong> with ${fmtIN(c.active_mentors)} mentors active.`);
    if (Number(c.checkins) || Number(c.levers_delivered)) {
      parts.push(`Along the way, <strong>${fmtIN(c.checkins)} wellbeing check-ins</strong> were recorded and <strong>${fmtIN(c.levers_delivered)} support levers</strong> delivered${Number(c.aid_amount) ? ` (₹${fmtIN(c.aid_amount)} in aid)` : ''}${Number(c.sessions_held) ? `, plus ${fmtIN(c.sessions_held)} one-to-one session${Number(c.sessions_held) === 1 ? '' : 's'} held` : ''}.`);
    }
    if (Number(c.new_patients)) {
      parts.push(`The registry grew by <strong>${fmtIN(c.new_patients)} patients</strong>${Number(c.consents) ? ` and ${fmtIN(c.consents)} gave consent` : ''}, now <strong>${fmtIN(d.total_patients)} active people</strong> in our care.`);
    }
    if (Number(d.open_concerns)) {
      const resolvedTxt = Number(c.concerns_resolved)
        ? `${fmtIN(c.concerns_resolved)} were resolved in this window`
        : `<strong>none resolved in this window</strong>`;
      parts.push(`<span style="color:#B0433A">⚑ <strong>${fmtIN(d.open_concerns)} concerns are open</strong> (${fmtIN(d.urgent_open)} urgent); ${fmtIN(c.concerns_opened)} were raised and ${resolvedTxt}. The Safety Net section below is today's first stop.</span>`);
    } else {
      parts.push(`The escalation queue is clear, no open concerns right now.`);
    }
    const el = document.getElementById('pulse-text');
    if (el) el.innerHTML = parts.join(' ');

    // KPI tiles with movement vs the previous window
    const tile = (val, label, chip, sub = '') => `
      <div class="card stat-card animate-fade-in">
        <div class="flex justify-between items-center" style="gap:6px">
          <div style="min-width:0">
            <div class="stat-value" style="display:flex;align-items:baseline;gap:8px">${val}${chip || ''}</div>
            <div class="stat-label">${label}</div>
            ${sub ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:2px">${sub}</div>` : ''}
          </div>
        </div>
      </div>`;
    const kpis = document.getElementById('pulse-kpis');
    if (kpis) {
      kpis.innerHTML =
        tile(fmtIN(c.calls), metricTerm('kpi_calls_made', 'Calls made'), deltaChip(c.calls, p.calls), `${connectPct}% connected`) +
        tile(fmtIN(c.families_reached), metricTerm('kpi_families_reached', 'Families reached'), deltaChip(c.families_reached, p.families_reached), `${fmtIN(c.talk_mins)} minutes of conversation`) +
        // Talk time as its own tile. It was only ever a sub-line, so a week
        // where the calls got shorter looked identical to a week where they
        // did not. Average is per CONNECTED call, since that is the only kind
        // that carries minutes.
        tile(fmtIN(c.talk_mins) + '<span style="font-size:14px;font-weight:600;color:var(--color-text-muted)"> min</span>',
          metricTerm('kpi_talk_mins', 'Talk time'), deltaChip(c.talk_mins, p.talk_mins),
          c.connected ? `${(c.talk_mins / c.connected).toFixed(1)} min per connected call` : 'no connected calls in window') +
        tile(fmtIN(c.checkins), metricTerm('kpi_checkins', 'Wellbeing check-ins'), deltaChip(c.checkins, p.checkins), `${fmtIN(c.levers_delivered)} support levers delivered`) +
        tile(fmtIN(d.open_concerns), metricTerm('kpi_concerns_open', 'Concerns open now'), deltaChip(c.concerns_opened, p.concerns_opened, false), `${fmtIN(d.urgent_open)} urgent · ${fmtIN(c.concerns_resolved)} resolved in window`);
    }
  } catch (err) { console.error('Pulse error:', err); }
}

// Hero "how are we helping" numbers (all-time).
async function loadHeadline() {
  const sb = getSupabase();
  const fmtRs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  try {
    const { data, error } = await sb.rpc('get_headline_impact', { p_filters: F() });
    if (error) throw error;
    const d = data || {};
    const card = (val, label, sub, color, svg) => `
      <div class="card stat-card animate-fade-in">
        <div class="flex justify-between items-center">
          <div><div class="stat-value">${val}</div><div class="stat-label">${label}</div>
            ${sub ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:2px">${sub}</div>` : ''}</div>
          <div class="stat-icon" style="background:${color}14;color:${color};border-color:${color}22">${svg}</div>
        </div>
      </div>`;
    const el = document.getElementById('impact-headline');
    if (!el) return;
    el.innerHTML =
      card(fmtRs(d.aid_disbursed), metricTerm('hero_aid', 'Financial aid disbursed'), `${d.aid_families || 0} families`, '#006469', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>') +
      card(d.patients_improved || 0, metricTerm('hero_improved', 'Patients improved'), 'on ≥1 wellbeing measure', '#2C7A52', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>') +
      card(d.support_delivered || 0, metricTerm('hero_support', 'Support actions delivered'), `${d.wellbeing_sessions || 0} well-being sessions`, '#5B4892', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>') +
      card(d.assessments || 0, 'Wellbeing check-ins logged',
        `${instrumentChip('phq4_patient', 'PHQ-4')} ${instrumentChip('qol_physical', 'QoL')} ${instrumentChip('must_malnutrition', 'MUST')} ${instrumentChip('zarit_burden', 'Zarit')} <span style="color:var(--ink-4)">(hover any to see the questions)</span>`,
        '#5B4892', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>');
  } catch (err) { console.error('Headline error:', err); }
}

// ── REACH ────────────────────────────────────────────────────

// Registry growth: daily intake bars; cumulative told in the story.
async function loadIntakeTrend() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_intake_trend', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    const rows = data.series || [];
    if (!rows.length) return;
    P.intake = { window_new: Number(data.window_new), registry_now: Number(data.registry_now) };
    mkChart('chart-intake', 'bar', {
      labels: rows.map(r => new Date(r.day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })),
      datasets: [{
        label: 'New patients',
        data: rows.map(r => Number(r.new_patients)),
        backgroundColor: 'rgba(23,173,180,0.6)', borderColor: CHART_COLORS.accent,
        borderWidth: 1, borderRadius: 3, maxBarThickness: 16,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { afterLabel: (ctx) => `registry total: ${fmtIN(rows[ctx.dataIndex].cumulative)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 14 } } },
    });
    const first = rows[0], last = rows[rows.length - 1];
    setStory('chart-intake',
      `<strong>${fmtIN(data.window_new)} new patients</strong> joined in the last ${rangeLabel()}. The registry grew from ` +
      `${fmtIN(Number(first.cumulative) - Number(first.new_patients))} to <strong>${fmtIN(last.cumulative)} people</strong>. ` +
      `Hover any bar to see the registry size that day. Spikes are bulk intake days from hospital lists; the quiet days in between are when those families get their first calls.`);
  } catch (err) { console.error('Intake trend error:', err); }
}

async function loadCancerDistribution() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_gi_subtype_mix', { p_filters: F() });
    if (error) throw error;
    if (!data || data.length === 0) return;
    mkChart('chart-cancer-types', 'doughnut', {
      labels: data.map(d => d.subtype === 'unclassified' ? 'Unclassified' : (giLabel(d.subtype) || capitalize(d.subtype))),
      datasets: [{
        data: data.map(d => d.n),
        backgroundColor: CHART_PALETTE.slice(0, data.length),
        borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } },
      cutout: '65%',
      filterOn: { facet: 'cancer', values: data.map(d => d.subtype) },
    });
    const total = data.reduce((a, d) => a + Number(d.n), 0);
    const named = data.filter(d => d.subtype !== 'unclassified');
    const top = named[0];
    const uncl = data.find(d => d.subtype === 'unclassified');
    P.reachSubtype = { top: top ? (giLabel(top.subtype) || top.subtype) : null, topN: top ? Number(top.n) : 0, total };
    if (top) {
      setStory('chart-cancer-types',
        `<strong>${giLabel(top.subtype) || capitalize(top.subtype)}</strong> is our largest group, ${fmtIN(top.n)} of ${fmtIN(total)} patients (${pct(top.n, total)}%)` +
        `${named[1] ? `, followed by ${giLabel(named[1].subtype) || named[1].subtype} (${named[1].n})` : ''}. ` +
        `${uncl ? `${fmtIN(uncl.n)} are still unclassified. Each one is a diagnosis question for the next call.` : ''}`);
    }
  } catch (err) { console.error('GI subtype mix error:', err); }
}

async function loadStageDistribution() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_stage_distribution', { p_filters: F() });
    if (error) throw error;
    if (!data || data.length === 0) return;
    const stageLabels = {
      stage_i: 'Stage I', stage_ii: 'Stage II', stage_iii: 'Stage III',
      stage_iv: 'Stage IV', unknown: 'Unknown', not_applicable: 'N/A'
    };
    mkChart('chart-stages', 'pie', {
      labels: data.map(d => stageLabels[d.stage] || d.stage),
      datasets: [{
        data: data.map(d => d.patient_count),
        backgroundColor: [CHART_COLORS.success, CHART_COLORS.info, CHART_COLORS.warning, CHART_COLORS.danger, CHART_COLORS.slate, 'rgba(100,116,139,0.4)'],
        borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } },
      filterOn: { facet: 'stage', values: data.map(d => d.stage) },
    });
    const n = (k) => Number(data.find(d => d.stage === k)?.patient_count || 0);
    const known = n('stage_i') + n('stage_ii') + n('stage_iii') + n('stage_iv');
    const late = n('stage_iii') + n('stage_iv');
    P.reachStage = { known, late, unknown: n('unknown') };
    if (known) {
      setStory('chart-stages',
        `Of the ${fmtIN(known)} patients whose stage we know, <strong>${pct(late, known)}% were already at stage III or IV</strong> when we first reached them. ` +
        `That is the reality this program exists for. Families meet us late, so palliative-side support (nutrition, finances, caregiver relief) matters as much as treatment navigation. ` +
        `${n('unknown') ? `Stage is still unknown for ${fmtIN(n('unknown'))} people.` : ''}`);
    }
  } catch (err) { console.error('Stage distribution error:', err); }
}

// REACH cohort: vulnerability bands, trajectory mix, subtype×stage matrix.
async function loadReachCohort() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_reach_cohort', { p_filters: F() });
    if (error) throw error;
    const d = data || {};
    // vulnerability bands
    const vb = d.vulnerability || [];
    if (vb.length) {
      const colorFor = (b) => b.startsWith('High') ? CHART_COLORS.danger : b.startsWith('Moderate') ? CHART_COLORS.warning : b.startsWith('Low') ? CHART_COLORS.success : CHART_COLORS.slate;
      mkChart('chart-vulnerability', 'bar', {
        labels: vb.map(x => x.band),
        datasets: [{ data: vb.map(x => x.n), backgroundColor: vb.map(x => colorFor(x.band).replace('1)', '0.6)')), borderColor: vb.map(x => colorFor(x.band)), borderWidth: 1, borderRadius: 6, maxBarThickness: 40 }],
      }, { ...liveAnim(), plugins: { legend: { display: false } },
           filterOn: { facet: 'vuln', values: vb.map(x => x.band) } });
      const high = vb.find(x => x.band.startsWith('High'));
      const total = vb.reduce((a, x) => a + Number(x.n), 0);
      P.reachVuln = { high: high ? Number(high.n) : 0, total };
      if (high) {
        setStory('chart-vulnerability',
          `<strong>${fmtIN(high.n)} households (${pct(high.n, total)}%) sit in the high-vulnerability band</strong>: low income, thin insurance, dependents at home, far from treatment. ` +
          `These are the families where one delivered support lever changes the week. The equity chart in ACTION checks whether they're actually getting more of our help.`);
      }
    }
    // trajectory
    const tr = d.trajectory || [];
    if (tr.length) {
      const lbl = (k) => TRAJECTORIES.find(t => t.key === k)?.label || capitalize(k);
      mkChart('chart-trajectory', 'doughnut', {
        labels: tr.map(x => lbl(x.trajectory)),
        datasets: [{ data: tr.map(x => x.n), backgroundColor: [CHART_COLORS.success, CHART_COLORS.warning, CHART_COLORS.info, CHART_COLORS.slate], borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6 }],
      }, { ...liveAnim(), plugins: { legend: { position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } }, cutout: '62%',
           filterOn: { facet: 'trajectory', values: tr.map(x => x.trajectory) } });
      const total = tr.reduce((a, x) => a + Number(x.n), 0);
      const pall = tr.find(x => x.trajectory === 'palliative');
      const cur = tr.find(x => x.trajectory === 'curative');
      setStory('chart-trajectory',
        `${cur ? `<strong>${fmtIN(cur.n)}</strong> patients are on a curative path` : ''}${cur && pall ? ' and ' : ''}` +
        `${pall ? `<strong>${fmtIN(pall.n)}</strong> are palliative (${pct(pall.n, total)}%)` : ''}. ` +
        `The two need different conversations. Cure-path families need treatment navigation; palliative families need comfort, nutrition and caregiver support. The worklist cadence already treats them differently.`);
    }
    // subtype × stage (stacked)
    const ss = d.subtype_stage || [];
    if (ss.length) {
      const subtypes = [...new Set(ss.map(x => x.subtype))];
      const stages = ['stage_i', 'stage_ii', 'stage_iii', 'stage_iv', 'unknown'];
      const stageLbl = { stage_i: 'I', stage_ii: 'II', stage_iii: 'III', stage_iv: 'IV', unknown: '?' };
      const stageCol = { stage_i: CHART_COLORS.success, stage_ii: CHART_COLORS.info, stage_iii: CHART_COLORS.warning, stage_iv: CHART_COLORS.danger, unknown: CHART_COLORS.slate };
      mkChart('chart-subtype-stage', 'bar', {
        labels: subtypes.map(s => giLabel(s) || capitalize(s)),
        datasets: stages.map(st => ({
          label: 'Stage ' + stageLbl[st],
          data: subtypes.map(sub => Number(ss.find(x => x.subtype === sub && x.stage === st)?.n || 0)),
          backgroundColor: (stageCol[st] || CHART_COLORS.slate).replace('1)', '0.7)'), borderColor: stageCol[st], borderWidth: 1, maxBarThickness: 34,
        })),
      }, { ...liveAnim(), plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 10, font: { size: 11 } } } }, scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } } });
      // which subtype is caught latest?
      let worst = null;
      for (const sub of subtypes) {
        const rows = ss.filter(x => x.subtype === sub);
        const known = rows.filter(r => r.stage !== 'unknown').reduce((a, r) => a + Number(r.n), 0);
        const late = rows.filter(r => r.stage === 'stage_iii' || r.stage === 'stage_iv').reduce((a, r) => a + Number(r.n), 0);
        if (known >= 10) {
          const share = late / known;
          if (!worst || share > worst.share) worst = { sub, share, known };
        }
      }
      if (worst) {
        setStory('chart-subtype-stage',
          `<strong>${giLabel(worst.sub) || capitalize(worst.sub)}</strong> is the subtype we meet latest. ` +
          `<strong>${Math.round(worst.share * 100)}%</strong> of its staged patients were already at stage III/IV at first contact (n=${worst.known}). ` +
          `Where a subtype's bar is mostly red and amber, early-detection messaging in that community is the long-term lever.`);
      }
    }
  } catch (err) { console.error('REACH cohort error:', err); }
}

async function loadFinancial() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_insight_financial', { p_filters: F() });
    if (error) throw error;
    if (!data || data.length === 0) return;
    const labels = { uninsured: 'Uninsured', govt_scheme: 'Govt scheme', insured: 'Insured', unknown: 'Unknown' };
    const colorBy = { uninsured: CHART_COLORS.danger, govt_scheme: CHART_COLORS.warning, insured: CHART_COLORS.success, unknown: CHART_COLORS.slate };
    mkChart('chart-financial', 'doughnut', {
      labels: data.map(d => labels[d.status] || capitalize(d.status)),
      datasets: [{
        data: data.map(d => d.n),
        backgroundColor: data.map(d => colorBy[d.status] || CHART_COLORS.slate),
        borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } },
      cutout: '62%',
      filterOn: { facet: 'insurance', values: data.map(d => d.status) },
    });
    const total = data.reduce((a, d) => a + Number(d.n), 0);
    const unins = Number(data.find(d => d.status === 'uninsured')?.n || 0);
    const govt = Number(data.find(d => d.status === 'govt_scheme')?.n || 0);
    const unk = Number(data.find(d => d.status === 'unknown')?.n || 0);
    setStory('chart-financial',
      `<strong>${fmtIN(unins)} families (${pct(unins, total)}%) have no insurance at all</strong> and ${fmtIN(govt)} lean on government schemes. ` +
      `Those two groups are where financial-aid navigation earns its keep. ` +
      `${unk ? `We still don't know the insurance status of ${fmtIN(unk)} families; it's one gentle question on the next call.` : ''}`);
  } catch (err) { console.error('Financial error:', err); }
}

async function loadGeographic() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_geographic', { p_filters: F() });
    if (error) throw error;
    if (!data || data.length === 0) return;
    mkChart('chart-geographic', 'bar', {
      labels: data.map(d => d.state),
      datasets: [{
        data: data.map(d => d.patient_count),
        backgroundColor: 'rgba(12,110,116,0.55)', borderColor: CHART_COLORS.primary,
        borderWidth: 1, borderRadius: 6, maxBarThickness: 30,
      }],
    }, { ...liveAnim(), indexAxis: 'y', plugins: { legend: { display: false } },
         filterOn: { facet: 'state', values: data.map(d => d.state) } });
    const total = data.reduce((a, d) => a + Number(d.patient_count), 0);
    const top = data[0];
    setStory('chart-geographic',
      `<strong>${top.state}</strong> leads with ${fmtIN(top.patient_count)} patients (${pct(top.patient_count, total)}% of the mapped ${fmtIN(total)}), across ${data.length} states in all. ` +
      `Geography decides what help means. Distance to a treatment centre is part of the vulnerability score, and the resources directory is organised by state for exactly this reason.`);
  } catch (err) { console.error('Geographic error:', err); }
}

// Demographics: age bands (ordinal ramp), languages; gender told in the story.
async function loadDemographics() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_patient_demographics', { p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    const ages = data.age_bands || [];
    if (ages.length) {
      // ordered bands → one hue, light→dark (unknown stays gray)
      const ramp = ['rgba(12,110,116,0.25)', 'rgba(12,110,116,0.42)', 'rgba(12,110,116,0.58)', 'rgba(12,110,116,0.74)', 'rgba(12,110,116,0.9)'];
      mkChart('chart-age', 'bar', {
        labels: ages.map(a => a.band),
        datasets: [{
          data: ages.map(a => Number(a.n)),
          backgroundColor: ages.map(a => a.band === 'Unknown' ? 'rgba(123,135,131,0.4)' : ramp[Math.min(a.ord - 1, 4)]),
          borderColor: ages.map(a => a.band === 'Unknown' ? 'rgba(123,135,131,1)' : CHART_COLORS.primary),
          borderWidth: 1, borderRadius: 5, maxBarThickness: 36,
        }],
      }, { ...liveAnim(), plugins: { legend: { display: false } },
           filterOn: { facet: 'age_band', values: ages.map(a => a.band) } });
      const known = ages.filter(a => a.band !== 'Unknown');
      const total = known.reduce((a, x) => a + Number(x.n), 0);
      const top = [...known].sort((a, b) => Number(b.n) - Number(a.n))[0];
      const young = known.filter(a => ['0-18', '19-35'].includes(a.band)).reduce((a, x) => a + Number(x.n), 0);
      const g = Object.fromEntries((data.gender || []).map(x => [x.gender, Number(x.n)]));
      if (top) {
        setStory('chart-age',
          `Most patients are <strong>${top.band}</strong> (${fmtIN(top.n)} of ${fmtIN(total)} with known age), but <strong>${fmtIN(young)} are 35 or younger</strong>, ` +
          `working-age and young families where a cancer diagnosis takes the household income with it. ` +
          `The registry is ${pct(g.male, (g.male || 0) + (g.female || 0))}% men, ${pct(g.female, (g.male || 0) + (g.female || 0))}% women among those who shared.`);
      }
    }
    const langs = data.language || [];
    if (langs.length) {
      const known = langs.filter(l => l.language !== 'Not recorded');
      mkChart('chart-language', 'bar', {
        labels: known.map(l => l.language),
        datasets: [{
          data: known.map(l => Number(l.n)),
          backgroundColor: 'rgba(106,87,166,0.55)', borderColor: 'rgba(106,87,166,1)',
          borderWidth: 1, borderRadius: 6, maxBarThickness: 28,
        }],
      }, { ...liveAnim(), indexAxis: 'y', plugins: { legend: { display: false } },
           filterOn: { facet: 'lang', values: known.map(l => l.language) } });
      const unk = Number(langs.find(l => l.language === 'Not recorded')?.n || 0);
      const top = known[0];
      const rel = (data.caregiver_rel || []).filter(r => r.rel !== 'Unknown');
      if (top) {
        setStory('chart-language',
          `<strong>${top.language}</strong> is the most common language (${fmtIN(top.n)} families)${known[1] ? `, then ${known[1].language} (${fmtIN(known[1].n)})` : ''}. Matching mentor to language is what makes the warmth in the warming curve possible. ` +
          `${unk ? `Language is unrecorded for <strong>${fmtIN(unk)}</strong> families, an easy first-call question. ` : ''}` +
          `${rel.length ? `On the other end of the phone it's most often the <strong>${rel[0].rel.toLowerCase()}</strong> (${fmtIN(rel[0].n)} families)${rel[1] ? `, then the ${rel[1].rel.toLowerCase()} (${fmtIN(rel[1].n)})` : ''}.` : ''}`);
      }
    }
  } catch (err) { console.error('Demographics error:', err); }
}

async function loadStatusMix() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_status_mix', { p_filters: F() });
    if (error) throw error;
    if (!data || data.length === 0) return;
    const labelOf = (k) => PATIENT_STATUSES.find(s => s.key === k)?.label || capitalize(k);
    const colorOf = { new_lead: CHART_COLORS.info, active: CHART_COLORS.success, inactive: CHART_COLORS.slate, deceased: CHART_COLORS.accent };
    mkChart('chart-status-mix', 'doughnut', {
      labels: data.map(d => labelOf(d.status)),
      datasets: [{
        data: data.map(d => d.n),
        backgroundColor: data.map(d => colorOf[d.status] || CHART_COLORS.slate),
        borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } },
      cutout: '62%',
      filterOn: { facet: 'status', values: data.map(d => d.status) },
    });
    const n = (k) => Number(data.find(d => d.status === k)?.n || 0);
    const total = data.reduce((a, d) => a + Number(d.n), 0);
    setStory('chart-status-mix',
      `<strong>${fmtIN(n('active'))} of ${fmtIN(total)} people (${pct(n('active'), total)}%) are in active care</strong>, with ${fmtIN(n('new_lead'))} new leads waiting for a first conversation. ` +
      `${n('deceased') ? `${fmtIN(n('deceased'))} patients have passed. Their families stay with us for bereavement support, not as closed rows.` : ''}`);
  } catch (err) { console.error('Status mix error:', err); }
}

// Navigation outcomes: the five report headings, mapped from each patient's
// live status. Same data as the lifecycle chart (get_status_mix), retold in the
// language our reports use.
async function loadNavigationOutcomes() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_status_mix', { p_filters: F() });
    if (error) throw error;
    const el = document.getElementById('nav-outcomes');
    if (!el || !data || data.length === 0) return;
    const n = (k) => Number(data.find(d => d.status === k)?.n || 0);
    const total = data.reduce((a, d) => a + Number(d.n), 0);
    // Anything outside the four standard statuses (incl. new leads) rolls into
    // Other, so the five headings always sum to the whole registry.
    const other = data.filter(d => !['active', 'inactive', 'deceased'].includes(d.status))
      .reduce((a, d) => a + Number(d.n), 0);
    const OUTCOMES = [
      { label: 'Successfully completed', nn: 0, color: '#2C7A52', note: 'no status marks completion yet',
        tip: 'The program is ongoing. No patient status marks a completed navigation episode yet, so this reads 0 by definition, not because nobody finished treatment.' },
      { label: 'Ongoing navigation', nn: n('active'), color: '#006469', note: 'active in our care',
        tip: 'Patients with status "Active": currently being called and supported.' },
      { label: 'Lost to follow-up', nn: n('inactive'), color: '#B0780E', note: 'inactive · unreachable',
        tip: 'Patients with status "Inactive". We could not stay in touch with the family.' },
      { label: 'Deceased', nn: n('deceased'), color: '#5B4892', note: 'families stay for bereavement care',
        tip: 'Patients with status "Deceased". Their families stay with us for bereavement support.' },
      { label: 'Other', nn: other, color: '#7B8783', note: 'new leads awaiting first call',
        tip: 'New leads: registered but navigation has not started yet (plus any status outside the four standard ones).' },
    ];
    el.innerHTML = OUTCOMES.map(o => `
      <div title="${o.tip}" style="border:1px solid ${o.color}33;background:${o.color}0d;border-radius:var(--r-sm);padding:12px 14px;text-align:center">
        <div style="font-family:var(--font-display);font-size:26px;font-weight:790;color:${o.color}">${fmtIN(o.nn)}</div>
        <div style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:.14em;color:${o.color}">${pct(o.nn, total)}% OF ${fmtIN(total)}</div>
        <div style="font-size:11.5px;font-weight:600;color:var(--ink-2);margin-top:4px;line-height:1.25">${o.label}</div>
        <div style="font-size:10.5px;color:var(--ink-3);margin-top:2px">${o.note}</div>
      </div>`).join('');
    setStory('nav-outcomes',
      `Of <strong>${fmtIN(total)} people registered</strong>, <strong>${fmtIN(n('active'))} (${pct(n('active'), total)}%) are in ongoing navigation</strong>; ` +
      `${fmtIN(other)} are new leads still waiting for a first conversation, ${fmtIN(n('inactive'))} are lost to follow-up and ${fmtIN(n('deceased'))} have passed. ` +
      `“Successfully completed” stays 0 while the program is ongoing. No status marks a closed navigation episode yet.`);
  } catch (err) { console.error('Navigation outcomes error:', err); }
}

// What % of active patients have each key field filled, sorted worst-first.
async function loadCompleteness() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_data_completeness', { p_filters: F() });
    if (error) throw error;
    const total = Number(data?.total || 0);
    if (!total) return;
    const fields = [...(data.fields || [])].sort((a, b) => a.known - b.known);
    const pctOf = (known) => Math.round((Number(known) / total) * 100);
    const pcts = fields.map(f => pctOf(f.known));
    mkChart('chart-completeness', 'bar', {
      labels: fields.map(f => f.label),
      datasets: [{
        data: pcts,
        backgroundColor: pcts.map(v => v < 40 ? CHART_COLORS.danger.replace('1)', '0.6)') : v < 75 ? CHART_COLORS.warning.replace('1)', '0.6)') : CHART_COLORS.success.replace('1)', '0.6)')),
        borderColor: pcts.map(v => v < 40 ? CHART_COLORS.danger : v < 75 ? CHART_COLORS.warning : CHART_COLORS.success),
        borderWidth: 1, borderRadius: 5, maxBarThickness: 22,
      }],
    }, {
      ...liveAnim(),
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => {
          const f = fields[ctx.dataIndex];
          return `${f.known} of ${total} known (${ctx.parsed.x}%) · ${total - f.known} missing`;
        } } },
      },
      scales: { x: { max: 100, ticks: { callback: (v) => v + '%' } } },
    });
    const worst = fields[0];
    const known = fields.filter(f => pctOf(f.known) >= 75).length;
    if (worst) {
      setStory('chart-completeness',
        `Across ${fmtIN(total)} active patients, ${known} of ${fields.length} key fields are well covered (75%+). ` +
        `The biggest blind spot is <strong>${worst.label}</strong>, known for only ${pctOf(worst.known)}%. ` +
        `Families share more as trust grows (see the trust curve below), and the portal surfaces every missing question from call 2.`);
    }
  } catch (err) { console.error('Completeness error:', err); }
}

// ── ACTION ───────────────────────────────────────────────────

async function loadCallsTimeline() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_analytics_calls_timeline', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.length === 0) return;
    const labels = data.map(d => new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
    const canvas = document.getElementById('chart-calls-timeline');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    mkChart('chart-calls-timeline', 'line', {
      labels,
      datasets: [
        { label: 'Total Calls', data: data.map(d => d.total_calls), borderColor: CHART_COLORS.primary,
          backgroundColor: createGradient(ctx, CHART_COLORS.primary, 250), fill: true, tension: 0.4,
          pointRadius: 2, pointHoverRadius: 6, borderWidth: 2 },
        { label: 'Connected', data: data.map(d => d.connected_calls), borderColor: CHART_COLORS.success,
          backgroundColor: createGradient(ctx, CHART_COLORS.success, 250), fill: true, tension: 0.4,
          pointRadius: 2, pointHoverRadius: 6, borderWidth: 2 },
      ],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: false } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 14 } } },
    });
    const totalCalls = data.reduce((a, d) => a + Number(d.total_calls), 0);
    const conn = data.reduce((a, d) => a + Number(d.connected_calls), 0);
    // busiest day
    const busiest = [...data].sort((a, b) => Number(b.total_calls) - Number(a.total_calls))[0];
    P.calls = { totalCalls, conn };
    setStory('chart-calls-timeline',
      `<strong>${fmtIN(totalCalls)} calls</strong> in the last ${rangeLabel()}; <strong>${fmtIN(conn)} became real conversations (${pct(conn, totalCalls)}%)</strong>. ` +
      `${busiest && Number(busiest.total_calls) ? `The busiest day was ${new Date(busiest.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} with ${fmtIN(busiest.total_calls)} dials. ` : ''}` +
      `The gap between the lines is dials that didn't connect. Those roll forward automatically until we reach the family.`);
  } catch (err) { console.error('Calls timeline error:', err); }
}

// What happened to every dial: outcome mix + the best-time chart
// (both come from the same RPC, fetched once).
async function loadOutcomeMix() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_call_outcome_mix', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    renderBestTime(data);
    const rows = data.outcomes || [];
    const canvas = document.getElementById('chart-outcomes');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No calls in this window.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    const meta = Object.fromEntries(DIAL_STATUSES.map(d => [d.key, d.label]));
    const colorOf = {
      connected: CHART_COLORS.success, no_answer: CHART_COLORS.warning, busy: 'rgba(176,120,14,0.75)',
      callback_requested: CHART_COLORS.info, voicemail: CHART_COLORS.slate, wrong_number: CHART_COLORS.danger,
    };
    mkChart('chart-outcomes', 'doughnut', {
      labels: rows.map(r => meta[r.status] || capitalize(r.status)),
      datasets: [{
        data: rows.map(r => Number(r.n)),
        backgroundColor: rows.map(r => colorOf[r.status] || CHART_COLORS.slate),
        borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } },
      cutout: '62%',
    });
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    const n = (k) => Number(rows.find(r => r.status === k)?.n || 0);
    P.outcomes = { total, connected: n('connected'), wrong: n('wrong_number'), callback: n('callback_requested'), avgTalk: Number(data.avg_talk_mins || 0) };
    setStory('chart-outcomes',
      `Of <strong>${fmtIN(total)} dials</strong>, ${fmtIN(n('connected'))} connected and a connected call averages <strong>${data.avg_talk_mins} minutes</strong> of real conversation. ` +
      `${n('callback_requested') ? `${fmtIN(n('callback_requested'))} families asked us to call back, soft yeses, not rejections. ` : ''}` +
      `${n('wrong_number') ? `${fmtIN(n('wrong_number'))} numbers were wrong. The linked-phones cleanup exists to shrink this slice.` : ''}`);
  } catch (err) { console.error('Outcome mix error:', err); }
}

// Feeds the ACTION section insight (value pitch, WhatsApp joins in window).
async function loadCallQuality() {
  const sb = getSupabase();
  try {
    const { data: qual, error } = await sb.rpc('get_call_quality_mix', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (qual && !qual.error) {
      P.quality = { connected: Number(qual.connected), pitched: Number(qual.value_pitched), whatsapp: Number(qual.whatsapp_joined) };
    }
  } catch (err) { console.error('Call quality error:', err); }
}

// When families pick up: connect rate by IST hour.
function renderBestTime(mix) {
  try {
    const hours = (mix.by_hour || []).filter(h => Number(h.calls) >= 5 && h.hour >= 8 && h.hour <= 20);
    const canvas = document.getElementById('chart-besttime');
    if (!canvas) return;
    if (!hours.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>Not enough calls in this window to see a pattern yet.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    const rate = hours.map(h => pct(Number(h.connected), Number(h.calls)));
    mkChart('chart-besttime', 'bar', {
      labels: hours.map(h => `${h.hour > 12 ? h.hour - 12 : h.hour}${h.hour >= 12 ? 'pm' : 'am'}`),
      datasets: [{
        data: rate,
        backgroundColor: 'rgba(46,125,85,0.55)', borderColor: CHART_COLORS.success,
        borderWidth: 1, borderRadius: 5, maxBarThickness: 30,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y}% connect · ${hours[ctx.dataIndex].calls} dials` } } },
      scales: { y: { max: 100, ticks: { callback: (v) => v + '%' }, title: { display: true, text: 'connect rate' } } },
    });
    const best = [...hours].sort((a, b) => pct(b.connected, b.calls) - pct(a.connected, a.calls))[0];
    const dows = (mix.by_dow || []).filter(d => Number(d.calls) >= 10);
    const dowNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const bestDow = [...dows].sort((a, b) => pct(b.connected, b.calls) - pct(a.connected, a.calls))[0];
    P.bestTime = best ? { hour: best.hour, rate: pct(best.connected, best.calls) } : null;
    if (best) {
      setStory('chart-besttime',
        `Families answer most around <strong>${best.hour > 12 ? best.hour - 12 : best.hour}${best.hour >= 12 ? ' pm' : ' am'}</strong> (${pct(best.connected, best.calls)}% of ${best.calls} dials connect)` +
        `${bestDow ? `, and <strong>${dowNames[bestDow.dow]}</strong> is the strongest day (${pct(bestDow.connected, bestDow.calls)}%)` : ''}. ` +
        `Stacking the tough-to-reach families into those hours is free connect rate.`);
    }
  } catch (err) { console.error('Best time error:', err); }
}

// Lever families: the grouped view folds related lever keys into one bar
// (all the nutrition_* levers + nutritionist assignment, both clinical-trial
// levers, …) so the chart reads as programs, not key soup. Anything that
// matches no family keeps its own bar in both views.
const LEVER_FAMILIES = [
  { label: 'Nutrition',       test: (k) => k.startsWith('nutrition') },
  { label: 'Clinical trials', test: (k) => k.startsWith('trial_') || k.startsWith('clinical_trial') },
  { label: 'Financial help',  test: (k) => k.startsWith('financial_') },
  { label: 'Accommodation',   test: (k) => k.startsWith('accommodation_') },
  { label: 'Second opinion',  test: (k) => k.startsWith('second_opinion') },
];

// ACTION outcomes: delivered vs declined per lever family (the Detailed
// toggle restores per-lever bars) + requirements resolved.
async function loadActionOutcomes() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_action_outcomes', { p_filters: F() });
    if (error) throw error;
    const rows = (data?.levers || []).filter(l => Number(l.total) > 0);
    const canvas = document.getElementById('chart-action-outcomes');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No support levers recorded yet.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }

    // Fold levers into families; members are kept for the hover breakdown.
    const famRows = new Map();
    const grouped = [];
    for (const l of rows) {
      const fam = LEVER_FAMILIES.find(f => f.test(l.lever));
      if (!fam) { grouped.push({ label: leverLabel(l.lever), delivered: Number(l.delivered), declined: Number(l.declined) }); continue; }
      let g = famRows.get(fam.label);
      if (!g) { g = { label: fam.label, delivered: 0, declined: 0, members: [] }; famRows.set(fam.label, g); grouped.push(g); }
      g.delivered += Number(l.delivered); g.declined += Number(l.declined); g.members.push(l);
    }
    grouped.sort((a, b) => (b.delivered - a.delivered) || (b.declined - a.declined));
    const detailed = rows.map(l => ({ label: leverLabel(l.lever), delivered: Number(l.delivered), declined: Number(l.declined) }));

    const paint = () => {
      const view = leverView === 'grouped' ? grouped : detailed;
      // Explicit height per row so every bar keeps a readable label, no top-N cut.
      const wrap = canvas.closest('.chart-canvas-wrap');
      if (wrap) wrap.style.height = Math.max(330, view.length * 26 + 64) + 'px';
      mkChart('chart-action-outcomes', 'bar', {
        labels: view.map(v => v.label),
        datasets: [
          { label: 'Delivered', data: view.map(v => v.delivered), backgroundColor: CHART_COLORS.success.replace('1)', '0.7)'), borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
          { label: 'Declined / not needed', data: view.map(v => v.declined), backgroundColor: CHART_COLORS.slate.replace('1)', '0.5)'), borderColor: CHART_COLORS.slate, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
        ],
      }, {
        ...liveAnim(), indexAxis: 'y',
        plugins: {
          legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } },
          tooltip: { callbacks: { afterBody: (items) => {
            const row = view[items[0]?.dataIndex];
            if (!row?.members) return undefined;
            return ['', 'Made of:', ...row.members.map(m => `  ${leverLabel(m.lever)}: ${m.delivered} delivered · ${m.declined} declined`)];
          } } },
        },
        scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true, ticks: { autoSkip: false } } },
      });
    };
    paintLevers = paint;

    // Grouped ⇄ Detailed toggle: the choice sticks across refreshes and ranges.
    const syncLeverToggle = () => document.querySelectorAll('.lever-view-btn').forEach(b => {
      const on = b.dataset.view === leverView;
      b.style.background = on ? 'var(--ink)' : 'transparent';
      b.style.color = on ? 'var(--paper, #FFFDFA)' : 'var(--ink-2)';
    });
    const tog = document.getElementById('lever-view-toggle');
    if (tog && !tog.dataset.bound) {
      tog.dataset.bound = '1';
      tog.querySelectorAll('.lever-view-btn').forEach(b => b.addEventListener('click', () => {
        if (leverView === b.dataset.view) return;
        leverView = b.dataset.view;
        syncLeverToggle();
        paintLevers?.();
      }));
    }
    syncLeverToggle();
    paint();

    const req = data?.requirements || {};
    const header = canvas.closest('.chart-card').querySelector('.chart-header');
    if (req.asked && header && !header.querySelector('.js-req-badge')) {
      const resolved = pct(Number(req.resolved), Number(req.asked));
      header.insertAdjacentHTML('beforeend',
        `<span class="badge badge-ok js-req-badge" title="${req.resolved} of ${req.asked} patients had their main request resolved">${resolved}% requests resolved</span>`);
    }
    const delivered = rows.reduce((a, l) => a + Number(l.delivered), 0);
    const offered = rows.reduce((a, l) => a + Number(l.total), 0);
    const topFam = grouped[0];
    P.levers = { delivered, offered, top: topFam ? topFam.label : null };
    setStory('chart-action-outcomes',
      `<strong>${fmtIN(delivered)} of ${fmtIN(offered)} support offers landed (${pct(delivered, offered)}%).</strong> ` +
      `${topFam ? `The support families take up most is <strong>${topFam.label}</strong> (${fmtIN(topFam.delivered)} delivered${topFam.members ? ` across ${topFam.members.length} levers` : ''}). ` : ''}` +
      `A "declined" is still a data point. It tells us which offers need better framing or better timing.`);
  } catch (err) { console.error('ACTION outcomes error:', err); }
}

// Are we reaching the most vulnerable? avg levers delivered by vulnerability band.
async function loadSupportEquity() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_support_equity', { p_filters: F() });
    if (error) throw error;
    const bands = (data?.bands || []).filter(b => b.band !== 'Unknown');
    if (!bands.length) return;
    const colorFor = (b) => b.startsWith('High') ? CHART_COLORS.danger : b.startsWith('Moderate') ? CHART_COLORS.warning : CHART_COLORS.success;
    mkChart('chart-support-equity', 'bar', {
      labels: bands.map(b => b.band),
      datasets: [{ data: bands.map(b => Number(b.avg_levers)), backgroundColor: bands.map(b => colorFor(b.band).replace('1)', '0.6)')), borderColor: bands.map(b => colorFor(b.band)), borderWidth: 1, borderRadius: 6, maxBarThickness: 40 }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => { const b = bands[ctx.dataIndex]; return [`avg ${b.avg_levers} levers · ${b.patients} patients`, `₹${Number(b.total_aid || 0).toLocaleString('en-IN')} aid · ${b.no_support} with no support yet`]; } } } },
      scales: { y: { title: { display: true, text: 'avg support levers delivered' } } },
    });
    if (data?.care_gap != null) {
      document.getElementById('chart-support-equity')?.closest('.chart-card').querySelector('.chart-header')
        ?.insertAdjacentHTML('beforeend', `<span class="badge badge-warn" title="active patients with no support lever delivered yet">${data.care_gap} need a first lever</span>`);
    }
    const high = bands.find(b => b.band.startsWith('High'));
    const low = bands.find(b => b.band.startsWith('Low'));
    if (high && low) {
      const fair = Number(high.avg_levers) >= Number(low.avg_levers);
      P.equity = { fair, highNoSupport: Number(high.no_support || 0) };
      setStory('chart-support-equity',
        `High-need families average <strong>${high.avg_levers} support levers</strong> versus ${low.avg_levers} for low-need ones. ` +
        (fair ? 'Help is flowing to where the need is greatest. The equity story holds.'
              : `The most vulnerable are getting LESS support than the least. ${high.no_support} high-need patients have no lever yet. Start there.`));
    }
  } catch (err) { console.error('Support equity error:', err); }
}

// ── "What patients ask for" ──────────────────────────────────
// This card has its own controls on top of the page filter: pick one cancer or
// All, count asks or families, and open the full cancer-by-ask table right here
// instead of downloading a spreadsheet to answer one question.
//
// The number itself: ONE ask per call per category, read from both the ticked
// list and the typed note and deduplicated. The old figure summed the ticked
// list with a keyword sweep of caller notes, which counted every ticked call
// twice and swept in notes that only mentioned a cost. See sql/62.
let reqCancer = 'all';        // 'all' | gi_subtype | 'unclassified'
let reqMetric = 'mentions';   // 'mentions' (times asked) | 'patients' (families)
let reqTableOpen = false;
let reqCrosstab = null;

function requirementsCard() {
  const seg = (v, label, tip) => `<button class="req-seg" data-metric="${v}" title="${tip}"
    style="border:0;cursor:pointer;padding:5px 10px;font-family:var(--font-mono);font-size:10.5px;background:${reqMetric === v ? 'var(--ink)' : 'transparent'};color:${reqMetric === v ? 'var(--paper, #FFFDFA)' : 'var(--ink-2)'}">${label}</button>`;
  return `
    <div class="chart-card chart-full-width animate-fade-in" style="animation-delay:200ms">
      <div class="chart-header">${metricTitle('requirements', 'What patients ask for')}
        <div class="flex gap-2" style="flex-wrap:wrap;justify-content:flex-end;align-items:center">
          <select id="req-cancer" class="select" title="Show one cancer type, or All for the whole picture"
            style="width:auto;padding:5px 26px 5px 10px;font-size:12px;min-width:150px"><option value="all">All cancers</option></select>
          <span role="group" aria-label="Count asks or families" style="display:inline-flex;border:1px solid var(--line-2);border-radius:8px;overflow:hidden">
            ${seg('mentions', 'Times asked', 'Every call where the family raised it. One call raising it twice still counts once.')}
            ${seg('patients', 'Families', 'Distinct families who have ever raised it, however many times they asked.')}
          </span>
          <button id="req-table" class="af-mini" title="Show the full cancer by ask table on this page">${reqTableOpen ? 'Hide table' : 'Show full table'}</button>
          <button id="req-dl" class="af-mini af-mini-solid" title="Download the numbers" style="padding:4px 8px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        </div>
      </div>
      <div id="req-meta" class="req-meta"></div>
      <div class="chart-canvas-wrap"><canvas id="chart-requirements"></canvas></div>
      ${storySlot('chart-requirements')}
      <div id="req-table-wrap" style="display:none"></div>
    </div>`;
}

const reqCancerLabel = (k) => k === 'all' ? 'All cancers'
  : (k === 'unclassified' || k === 'unknown') ? 'Cancer type not recorded'
    : (giLabel(k) || capitalize(k));

async function loadRequirements() {
  const sb = getSupabase();
  try {
    // Rebuild the cancer picker every load: under a page filter the available
    // cancers (and their counts) change, and offering a dead option is a lie.
    try {
      const { data: opts } = await sb.rpc('get_requirement_cancer_options', { p_filters: F() });
      const sel = document.getElementById('req-cancer');
      if (sel) {
        const list = opts || [];
        if (reqCancer !== 'all' && !list.some(o => o.gi_subtype === reqCancer)) reqCancer = 'all';
        const allAsks = list.reduce((a, o) => a + Number(o.asks), 0);
        sel.innerHTML = `<option value="all">All cancers · ${fmtIN(allAsks)} asks</option>` + list.map(o =>
          `<option value="${o.gi_subtype}"${o.gi_subtype === reqCancer ? ' selected' : ''}>${reqCancerLabel(o.gi_subtype)} · ${fmtIN(o.asks)}</option>`).join('');
      }
    } catch { /* the picker just stays at All cancers */ }

    const { data, error } = await sb.rpc('get_requirements_by_cancer',
      { p_gi_subtype: reqCancer, p_filters: F(), p_metric: reqMetric });
    if (error) throw error;
    if (!data || data.error) return;
    const rows = data.rows || [];
    const unit = reqMetric === 'patients' ? 'families' : 'asks';

    const meta = document.getElementById('req-meta');
    if (meta) {
      meta.innerHTML = `
        <span><strong>${fmtIN(data.total_mentions)}</strong> asks recorded</span>
        <span class="af-dot"></span><span><strong>${fmtIN(data.patients_asking)}</strong> families asked for something</span>
        <span class="af-dot"></span><span>across <strong>${fmtIN(data.calls_with_asks)}</strong> calls</span>
        <span class="af-dot"></span><span>out of ${fmtIN(data.cohort_patients)} patients in view</span>
        <button id="req-how" class="req-how" title="Exactly how this number is built">how is this counted?</button>`;
    }

    if (!rows.length) {
      mkChart('chart-requirements', 'bar', { labels: ['No recorded asks'], datasets: [{ data: [0], backgroundColor: 'rgba(12,110,116,0.25)' }] },
        { ...liveAnim(), indexAxis: 'y', plugins: { legend: { display: false } } });
      setStory('chart-requirements', 'Nobody in this view has a recorded ask yet.');
      if (reqTableOpen) renderReqTable();
      return;
    }

    mkChart('chart-requirements', 'bar', {
      labels: rows.map(d => d.label),
      datasets: [{
        label: reqMetric === 'patients' ? 'Families who asked' : 'Times asked',
        data: rows.map(d => d.n),
        backgroundColor: 'rgba(12,110,116,0.55)', borderColor: CHART_COLORS.primary,
        borderWidth: 1, borderRadius: 6, maxBarThickness: 28,
      }],
    }, {
      ...liveAnim(), indexAxis: 'y',
      plugins: { legend: { display: false },
        tooltip: { callbacks: { afterBody: (items) => {
          const r = rows[items[0]?.dataIndex]; if (!r) return undefined;
          return [`${r.mentions} asks from ${r.patients} families`,
            `${r.from_ticked} ticked on the form, ${r.from_typed_only} written in by the mentor`];
        } } } },
      scales: { x: { title: { display: true, text: reqMetric === 'patients' ? 'families who asked' : 'times asked' } } },
    });

    const total = rows.reduce((a, d) => a + Number(d.n), 0);
    const who = reqCancer === 'all' ? 'families in this view' : `${reqCancerLabel(reqCancer).toLowerCase()} patients`;
    const top = rows[0];
    setStory('chart-requirements',
      `Among <strong>${who}</strong>, <strong>${top.label.toLowerCase()}</strong> tops the list - ` +
      `<strong>${fmtIN(top.mentions)} asks from ${fmtIN(top.patients)} families</strong>` +
      `${rows[1] ? `, then ${rows[1].label.toLowerCase()} (${fmtIN(rows[1].mentions)} asks, ${fmtIN(rows[1].patients)} families)` : ''}. ` +
      `That is ${pct(top.n, total)}% of every ${unit.replace(/s$/, '')} recorded here. ` +
      `Use the picker above to read one cancer at a time, or open the full table for the whole grid.`);

    if (reqTableOpen) renderReqTable();
  } catch (err) { console.error('Requirements error:', err); }
}

// Delegated on the page root, bound once in renderAnalytics. The card is torn
// down and rebuilt on every filter and range change, so per-element listeners
// were a race: whichever rebuild landed after the wiring pass left dead buttons.
export function wireRequirementDelegates(root) {
  root.addEventListener('click', async (e) => {
    const seg = e.target.closest?.('.req-seg');
    if (seg) {
      if (reqMetric === seg.dataset.metric) return;
      reqMetric = seg.dataset.metric;
      root.querySelectorAll('.req-seg').forEach(x => {
        const on = x.dataset.metric === reqMetric;
        x.style.background = on ? 'var(--ink)' : 'transparent';
        x.style.color = on ? 'var(--paper, #FFFDFA)' : 'var(--ink-2)';
      });
      loadRequirements();
      return;
    }
    const tbl = e.target.closest?.('#req-table');
    if (tbl) {
      reqTableOpen = !reqTableOpen;
      tbl.textContent = reqTableOpen ? 'Hide table' : 'Show full table';
      const wrap = document.getElementById('req-table-wrap');
      if (wrap) wrap.style.display = reqTableOpen ? '' : 'none';
      if (reqTableOpen) await renderReqTable();
      return;
    }
    if (e.target.closest?.('#req-dl') || e.target.closest?.('#req-dl-table')) { downloadRequirements(); return; }
    if (e.target.closest?.('#req-how')) { showAskMethod(); return; }
    const cl = e.target.closest?.('.req-cancer-link');
    if (cl) { crossFilter('cancer', cl.dataset.cancer); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'req-cancer') { reqCancer = e.target.value; loadRequirements(); }
  });
}

// The whole grid, on the page. Rows are cancers, columns are asks, so you can
// read "which cancer asks for accommodation" without exporting anything.
async function renderReqTable() {
  const sb = getSupabase();
  const wrap = document.getElementById('req-table-wrap');
  if (!wrap) return;
  wrap.style.display = '';
  wrap.innerHTML = '<div style="padding:14px 0;color:var(--ink-3);font-size:12.5px">Building the table...</div>';
  try {
    const { data, error } = await sb.rpc('get_requirements_cancer_crosstab', { p_filters: F() });
    if (error) throw error;
    reqCrosstab = data || [];
    if (!reqCrosstab.length) { wrap.innerHTML = '<div class="empty" style="padding:var(--s4) 0"><p>No asks recorded for this cohort.</p></div>'; return; }

    const cancers = [...new Set(reqCrosstab.map(r => r.gi_subtype))];
    const asks = [...new Set(reqCrosstab.map(r => r.requirement))];
    // Column order: biggest ask first, so the eye lands on what matters.
    const askTotal = (a) => reqCrosstab.filter(r => r.requirement === a).reduce((s, r) => s + Number(r[reqMetric]), 0);
    asks.sort((a, b) => askTotal(b) - askTotal(a));
    const cancerTotal = (c) => reqCrosstab.filter(r => r.gi_subtype === c).reduce((s, r) => s + Number(r[reqMetric]), 0);
    cancers.sort((a, b) => cancerTotal(b) - cancerTotal(a));
    const cell = (c, a) => Number(reqCrosstab.find(r => r.gi_subtype === c && r.requirement === a)?.[reqMetric] || 0);
    const grandMax = Math.max(...cancers.flatMap(c => asks.map(a => cell(c, a))), 1);

    wrap.innerHTML = `
      <div class="req-table-head">
        <span>Every cancer type by every ask${isFiltered() ? ' <em>(inside the current filter)</em>' : ''} - counting ${reqMetric === 'patients' ? 'distinct families' : 'times asked'}</span>
        <button id="req-dl-table" class="af-mini">Download this table</button>
      </div>
      <div class="req-table-scroll">
        <table class="req-table">
          <thead><tr><th class="sticky-col">Cancer type</th>${asks.map(a => `<th>${a}</th>`).join('')}<th class="tot">Total</th></tr></thead>
          <tbody>
            ${cancers.map(c => `<tr>
              <td class="sticky-col"><button class="req-cancer-link" data-cancer="${c}" title="Filter the whole page to ${reqCancerLabel(c)}">${reqCancerLabel(c)}</button></td>
              ${asks.map(a => { const v = cell(c, a);
                return `<td${v ? ` style="background:rgba(12,110,116,${(0.06 + 0.5 * (v / grandMax)).toFixed(3)})"` : ''}>${v || '<span class="z">·</span>'}</td>`; }).join('')}
              <td class="tot">${fmtIN(cancerTotal(c))}</td></tr>`).join('')}
            <tr class="tot-row"><td class="sticky-col">All cancers</td>
              ${asks.map(a => `<td>${fmtIN(askTotal(a))}</td>`).join('')}
              <td class="tot">${fmtIN(cancers.reduce((s, c) => s + cancerTotal(c), 0))}</td></tr>
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="empty" style="padding:var(--s4) 0"><p>Could not build the table: ${e.message}</p></div>`;
  }
}

// Three sheets: the crosstab, the per-call audit trail, and the free text that
// no category caught. The audit trail is what makes the headline defensible.
async function downloadRequirements() {
  const sb = getSupabase();
  try {
    showToast('Preparing the ask data...', 'info');
    const [xt, det] = await Promise.all([
      sb.rpc('get_requirements_cancer_crosstab', { p_filters: F() }),
      sb.rpc('get_requirements_detail', { p_filters: F() }),
    ]);
    if (xt.error) throw xt.error;
    const rows = (xt.data || []).map(r => ({
      cancer: reqCancerLabel(r.gi_subtype), requirement: r.requirement,
      patients: r.patients, mentions: r.mentions,
    }));
    if (!rows.length) { showToast('Nothing to export for this cohort', 'warning'); return; }
    const suffix = isFiltered() ? '_filtered' : '';
    exportToCSV(rows, 'asks_by_cancer' + suffix, [
      { label: 'Cancer type', key: 'cancer' },
      { label: 'What they asked for', key: 'requirement' },
      { label: 'Families who asked', key: 'patients' },
      { label: 'Times asked', key: 'mentions' },
    ]);

    const d = det.data || {};
    if ((d.asks || []).length) setTimeout(() => exportToCSV(d.asks, 'asks_call_by_call' + suffix, [
      { label: 'Patient code', key: 'patient_code' }, { label: 'Patient', key: 'patient' },
      { label: 'Cancer type', key: 'cancer' }, { label: 'Stage', key: 'stage' },
      { label: 'What they asked for', key: 'requirement' },
      { label: 'How it was recorded', key: 'recorded_as' },
      { label: 'Call date', key: 'call_date' }, { label: 'Mentor', key: 'mentor' },
    ]), 400);
    if ((d.uncategorised || []).length) setTimeout(() => exportToCSV(d.uncategorised, 'asks_uncategorised_text' + suffix, [
      { label: 'Free text written by the mentor', key: 'text' }, { label: 'Times written', key: 'n' },
    ]), 800);
    showToast(`Exported ${rows.length} rows plus the call-by-call trail`, 'success');
  } catch (e) { showToast('Download failed: ' + e.message, 'error'); }
}

// Written out in full, because this number goes into reports.
function showAskMethod() {
  const html = `
    <p style="margin:0 0 10px">An <strong>ask</strong> is one family raising one kind of need on one call.</p>
    <ul style="margin:0 0 10px;padding-left:18px;line-height:1.65">
      <li>We read <strong>both</strong> places a mentor can record it: the tick list on the call form, and the note they type. Most calls have both.</li>
      <li>If a call ticks "Financial aid" <em>and</em> the mentor also writes it, that is <strong>one</strong> ask, not two.</li>
      <li>A call can carry several different asks. Each distinct kind counts once.</li>
      <li>"No requests", "nothing needed" and the like are answers, not asks, so they are excluded.</li>
      <li><strong>Times asked</strong> counts calls. <strong>Families</strong> counts distinct people, however often they asked.</li>
    </ul>
    <p style="margin:0 0 10px;padding:9px 11px;background:var(--warn-soft);border-radius:var(--r-sm);color:var(--ink-2)">
      <strong>If you are comparing to an older number:</strong> the previous version added a keyword sweep of every
      caller note on top of the tick list. Each ticked call was therefore counted twice, and notes that merely
      mentioned a cost were counted as asks. It also created a "Doctor / hospital" category from any note
      containing the word "hospital". Those figures were inflated and should not be reported.</p>
    <p style="margin:0">Download gives you three sheets: the cancer-by-ask table, every ask call by call with the date
      and mentor, and the free text no category caught. The middle one lets anyone re-derive the headline by hand.</p>`;
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.style.cssText = 'position:fixed;inset:0;z-index:900;background:var(--overlay,rgba(10,14,13,.55));display:grid;place-items:center;padding:18px';
  modal.innerHTML = `<div class="card" style="max-width:620px;max-height:84vh;overflow:auto">
      <div class="flex justify-between items-center" style="margin-bottom:10px">
        <h3 style="margin:0">How "what patients ask for" is counted</h3>
        <button class="btn btn-ghost btn-sm" id="ask-x">Close</button>
      </div>
      <div style="font-size:13.5px;line-height:1.6;color:var(--ink-2)">${html}</div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#ask-x').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

async function loadJourneyFunnel() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_call_stage_funnel', { p_filters: F() });
    if (error) throw error;
    const d = data || {};
    mkChart('chart-journey', 'bar', {
      labels: ['Reached once', 'Reached twice', 'Reached 3+ times', 'Gave consent', 'In WhatsApp group'],
      datasets: [{
        data: [d.reached_once || 0, d.reached_twice || 0, d.reached_three || 0, d.consented || 0, d.in_whatsapp || 0],
        // one hue, deepening with commitment: this is an ordered funnel
        backgroundColor: ['rgba(12,110,116,0.3)', 'rgba(12,110,116,0.45)', 'rgba(12,110,116,0.6)', 'rgba(12,110,116,0.75)', 'rgba(12,110,116,0.9)'],
        borderColor: CHART_COLORS.primary,
        borderWidth: 1, borderRadius: 6, maxBarThickness: 28,
      }],
    }, { ...liveAnim(), indexAxis: 'y', plugins: { legend: { display: false } } });
    if (d.reached_once) {
      P.journey = { once: Number(d.reached_once), three: Number(d.reached_three || 0) };
      setStory('chart-journey',
        `Of <strong>${fmtIN(d.reached_once)}</strong> families we've reached at least once, <strong>${fmtIN(d.reached_three || 0)} (${pct(d.reached_three, d.reached_once)}%) have stayed for three or more conversations</strong>. That's the relationship, not the transaction. ` +
        `${d.in_whatsapp ? `${fmtIN(d.in_whatsapp)} are inside the WhatsApp community for the days between calls.` : ''}`);
    }
  } catch (err) { console.error('Journey funnel error:', err); }
}

async function loadSessionsChart() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_group_sessions_summary', { p_filters: F() });
    if (error) throw error;
    const canvas = document.getElementById('chart-sessions');
    if (!canvas) return;
    if (!data || data.length === 0) {
      canvas.closest('.chart-card').insertAdjacentHTML('beforeend',
        '<div class="empty" style="padding:var(--s5) 0"><p>No Saturday circles logged yet: after each WhatsApp session, log it in Team → Saturday circles and the rhythm shows here.</p></div>');
      (canvas.closest('.chart-canvas-wrap')||canvas).remove();
      return;
    }
    const months = [...new Set(data.map(d => d.month))];
    const byType = (t) => months.map(m => Number(data.find(d => d.month === m && d.session_type === t)?.sessions || 0));
    mkChart('chart-sessions', 'bar', {
      labels: months,
      datasets: [
        { label: 'Nutrition', data: byType('nutrition'), backgroundColor: CHART_COLORS.success.replace('1)', '0.65)'), borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 5, maxBarThickness: 26 },
        { label: 'Well-being', data: byType('wellbeing'), backgroundColor: 'rgba(106,87,166,0.6)', borderColor: 'rgba(106,87,166,1)', borderWidth: 1, borderRadius: 5, maxBarThickness: 26 },
      ],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } } },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } },
    });
    const total = data.reduce((a, d) => a + Number(d.sessions), 0);
    const lastMonth = months[months.length - 1];
    const lastN = data.filter(d => d.month === lastMonth).reduce((a, d) => a + Number(d.sessions), 0);
    setStory('chart-sessions',
      `<strong>${fmtIN(total)} Saturday circles</strong> held so far: group sessions on WhatsApp where families learn together. ` +
      `${lastN ? `${fmtIN(lastN)} in ${lastMonth}; a steady weekly rhythm is the goal, so a shrinking bar is an early warning.` : ''}`);
  } catch (err) { console.error('Sessions chart error:', err); }
}

// 1:1 sessions: invited → agreed/scheduled → held pipeline.
async function loadSessionsPipeline() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_sessions_pipeline', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    const pipe = data.pipeline || [];
    const canvas = document.getElementById('chart-pipeline');
    if (!canvas) return;
    if (!pipe.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No 1:1 sessions invited yet. Invitations are made from the calling portal after a conversation.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    const stages = ['invited', 'agreed', 'scheduled', 'held'];
    const stageLbl = { invited: 'Invited', agreed: 'Said yes', scheduled: 'Scheduled', held: 'Held' };
    const kinds = [...new Set(pipe.map(p => p.kind))];
    const kindColor = { wellbeing: 'rgba(106,87,166,VAL)', nutrition: 'rgba(46,125,85,VAL)', caregiver: 'rgba(23,173,180,VAL)' };
    mkChart('chart-pipeline', 'bar', {
      labels: stages.map(s => stageLbl[s]),
      datasets: kinds.map(k => ({
        label: sessionKind(k).label,
        data: stages.map(s => pipe.filter(p => p.kind === k && p.status === s).reduce((a, p) => a + Number(p.n), 0)),
        backgroundColor: (kindColor[k] || 'rgba(123,135,131,VAL)').replace('VAL', '0.65'),
        borderColor: (kindColor[k] || 'rgba(123,135,131,VAL)').replace('VAL', '1'),
        borderWidth: 1, borderRadius: 4, maxBarThickness: 26,
      })),
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 10, font: { size: 11 } } } },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } },
    });
    const live = pipe.filter(p => ['invited', 'agreed', 'scheduled'].includes(p.status)).reduce((a, p) => a + Number(p.n), 0);
    const heldAll = pipe.filter(p => p.status === 'held').reduce((a, p) => a + Number(p.n), 0);
    P.pipeline = { live, heldWindow: Number(data.held_window || 0), invitedWindow: Number(data.invited_window || 0) };
    setStory('chart-pipeline',
      `<strong>${fmtIN(live)} invitations are alive in the pipeline</strong> (invited, said yes, or scheduled) and ${fmtIN(heldAll)} sessions have been held overall, ` +
      `<strong>${fmtIN(data.held_window || 0)} in the last ${rangeLabel()}</strong> against ${fmtIN(data.invited_window || 0)} new invitations. ` +
      `The gap between "said yes" and "held" is where interest quietly dies. Scheduling them within the week is the fix.` +
      `${Number(data.no_show_window) ? ` ${fmtIN(data.no_show_window)} no-show/cancelled in this window.` : ''}`);
  } catch (err) { console.error('Sessions pipeline error:', err); }
}

async function loadCallerPerformance() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_caller_performance_ranged', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.error || data.length === 0) return;
    mkChart('chart-caller-perf', 'bar', {
      labels: data.map(d => d.caller_name?.split(' ')[0] || 'Unknown'),
      datasets: [
        { label: 'Total calls', data: data.map(d => d.total_calls),
          backgroundColor: CHART_COLORS.primary.replace('1)', '0.6)'), borderColor: CHART_COLORS.primary, borderWidth: 1, borderRadius: 4, maxBarThickness: 20 },
        { label: 'Connected', data: data.map(d => d.connected_calls),
          backgroundColor: CHART_COLORS.success.replace('1)', '0.6)'), borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 4, maxBarThickness: 20 },
        { label: 'Distinct patients', data: data.map(d => d.patients_touched),
          backgroundColor: 'rgba(23,173,180,0.55)', borderColor: CHART_COLORS.accent, borderWidth: 1, borderRadius: 4, maxBarThickness: 20 },
      ],
    }, {
      ...liveAnim(),
      plugins: {
        legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { afterBody: (items) => { const r = data[items[0].dataIndex]; return `avg connected call: ${r.avg_duration} min`; } } },
      },
    });
    const totalCalls = data.reduce((a, d) => a + Number(d.total_calls), 0);
    const top = data[0];
    const deepest = [...data].filter(d => Number(d.connected_calls) >= 10).sort((a, b) => Number(b.avg_duration) - Number(a.avg_duration))[0];
    setStory('chart-caller-perf',
      `<strong>${data.length} mentors</strong> made ${fmtIN(totalCalls)} calls in the last ${rangeLabel()}. <strong>${top.caller_name}</strong> leads on volume (${fmtIN(top.total_calls)}). ` +
      `${deepest ? `<strong>${deepest.caller_name}</strong> goes deepest: ${deepest.avg_duration} minutes per connected call. ` : ''}` +
      `Volume and depth are different gifts. The leaderboard scores both.`);
  } catch (err) { console.error('Caller performance error:', err); }
}

// ── SAFETY NET: the concerns queue as data ─────────────────
async function loadConcerns() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_concerns_analytics', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    const reasons = data.by_reason || [];
    P.concerns = {
      opened: Number(data.opened), resolved: Number(data.resolved),
      backlog: data.backlog || [], median: data.median_days_to_resolve, auto: Number(data.auto_share || 0),
    };
    const canvas = document.getElementById('chart-concerns');
    if (canvas) {
      if (!reasons.length) {
        canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No concerns raised in this window: either a calm stretch or flags aren’t being raised. Both are worth knowing.</p></div>');
        (canvas.closest('.chart-canvas-wrap')||canvas).remove();
      } else {
        mkChart('chart-concerns', 'bar', {
          labels: reasons.map(r => concernReason(r.reason).label),
          datasets: [
            { label: 'Still open', data: reasons.map(r => Number(r.still_open)),
              backgroundColor: CHART_COLORS.danger.replace('1)', '0.6)'), borderColor: CHART_COLORS.danger, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
            { label: 'Handled', data: reasons.map(r => Number(r.n) - Number(r.still_open)),
              backgroundColor: CHART_COLORS.success.replace('1)', '0.55)'), borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
          ],
        }, {
          ...liveAnim(),
          indexAxis: 'y',
          plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } } },
          scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true } },
        });
        const top = reasons[0];
        setStory('chart-concerns',
          `<strong>${fmtIN(data.opened)} concerns were flagged in the last ${rangeLabel()}</strong>` +
          `${data.auto_share ? ` (${data.auto_share}% raised automatically by assessment thresholds: the system is watching even when nobody flags)` : ''}. ` +
          `The most common red flag is <strong>${concernReason(top.reason).label.toLowerCase()}</strong> (${fmtIN(top.n)}). ` +
          (Number(data.resolved)
            ? `${fmtIN(data.resolved)} were resolved${data.median_days_to_resolve != null ? `, typically in ${data.median_days_to_resolve} days` : ''}.`
            : `<strong>None have been resolved in this window</strong>. Flags are being caught but not closed; the triage loop needs an owner.`));
      }
    }
    // backlog tiles
    const bk = document.getElementById('concerns-backlog');
    if (bk) {
      const backlog = data.backlog || [];
      const sevMeta = { urgent: ['URGENT', '#953028'], high: ['HIGH', '#B0780E'], watch: ['WATCH', '#356690'] };
      const openTotal = backlog.reduce((a, b) => a + Number(b.n), 0);
      bk.innerHTML = backlog.length ? backlog.map(b => {
        const [lbl, col] = sevMeta[b.severity] || [b.severity, 'var(--ink-2)'];
        return `<div style="border:1px solid ${col}33;background:${col}0d;border-radius:var(--r-sm);padding:12px 14px;text-align:center">
          <div style="font-family:var(--font-display);font-size:26px;font-weight:790;color:${col}">${fmtIN(b.n)}</div>
          <div style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:.18em;color:${col}">${lbl}</div>
          <div style="font-size:11px;color:var(--ink-3);margin-top:3px">avg ${b.avg_age_days}d old · oldest ${b.oldest_days}d</div>
        </div>`;
      }).join('') : '<div class="empty" style="grid-column:1/-1;padding:var(--s4) 0"><p>Backlog clear. Every flag has been handled. 🎉</p></div>';
      if (backlog.length) {
        const oldest = Math.max(...backlog.map(b => Number(b.oldest_days)));
        setStory('concerns-backlog',
          `<strong>${fmtIN(openTotal)} flags are waiting for a human</strong> and the oldest has waited <strong>${oldest} days</strong>. ` +
          `Every one is a family that told us something serious. Triage lives in the Concerns page: acknowledge, act, resolve.`);
      }
    }
  } catch (err) { console.error('Concerns analytics error:', err); }
}

// ── NUTRITION: funnel, MUST risk mix, per-nutritionist activity ──
async function loadNutritionSection() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_nutrition_analytics', { days_back: currentRange, p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;

    // Funnel: one hue (magnitude), horizontal
    const f = data.funnel || {};
    P.nutrition = { touched: Number(f.touched), plan: Number(f.plan_given), high: Number(data.must?.high || 0), unscreened: Number(data.must?.unscreened || 0) };
    mkChart('chart-nutrition-funnel', 'bar', {
      labels: ['Nutrition-touched', 'Nutritionist assigned', 'Plan given', 'Adherence check', 'Follow-up done'],
      datasets: [{
        data: [f.touched, f.assigned, f.plan_given, f.adherence, f.followup].map(Number),
        backgroundColor: CHART_COLORS.success.replace('1)', '0.6)'),
        borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 5, maxBarThickness: 22,
      }],
    }, { ...liveAnim(), indexAxis: 'y', plugins: { legend: { display: false } } });
    if (f.touched) {
      setStory('chart-nutrition-funnel',
        `<strong>${f.touched}</strong> people have nutrition work on file. <strong>${f.plan_given}</strong> have a diet plan (${pct(f.plan_given, f.touched)}%), but only <strong>${f.adherence}</strong> had an adherence check. The drop-off after the plan is where patients quietly slip.`);
    }

    // MUST mix: status colors; legend labels carry meaning
    const m = data.must || {};
    const screened = Number(m.high || 0) + Number(m.medium || 0) + Number(m.low || 0);
    mkChart('chart-nutrition-must', 'doughnut', {
      labels: ['High risk (MUST ≥2)', 'Medium (1)', 'Low (0)', 'Not screened yet'],
      datasets: [{
        data: [m.high, m.medium, m.low, m.unscreened].map(Number),
        backgroundColor: [CHART_COLORS.danger, CHART_COLORS.warning, CHART_COLORS.success, 'rgba(123,135,131,0.55)'],
        borderColor: '#FFFDFA', borderWidth: 2, hoverOffset: 6,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } },
      cutout: '62%',
    });
    if (screened + Number(m.unscreened || 0) > 0) {
      setStory('chart-nutrition-must',
        `<strong>${m.high}</strong> ${Number(m.high) === 1 ? 'person is' : 'people are'} at high malnutrition risk and <strong>${m.unscreened}</strong> of ${screened + Number(m.unscreened)} still have no MUST score. Screening them is the fastest way to find who needs the team first.`);
    }

    // Team performance: grouped bars per nutritionist
    const team = (data.team || []).map(t => ({ ...t, checkins: Number(t.checkins), patients_reached: Number(t.patients_reached), sessions_held: Number(t.sessions_held) }));
    const canvas = document.getElementById('chart-nutrition-team');
    if (canvas && team.length) {
      const totalCheckins = team.reduce((s, t) => s + t.checkins, 0);
      if (!totalCheckins && !team.some(t => t.sessions_held)) {
        canvas.closest('.chart-card').insertAdjacentHTML('beforeend',
          `<div class="empty" style="padding:var(--s5) 0"><p>No nutrition check-ins logged in this window yet. Check-ins are logged from the Nutrition worklist → “Nutrition check-in”.</p></div>`);
        (canvas.closest('.chart-canvas-wrap')||canvas).remove();
      } else {
        mkChart('chart-nutrition-team', 'bar', {
          labels: team.map(t => t.name),
          datasets: [
            { label: 'Check-ins', data: team.map(t => t.checkins), backgroundColor: 'rgba(12,110,116,0.65)', borderColor: CHART_COLORS.primary, borderWidth: 1, borderRadius: 5, maxBarThickness: 20 },
            { label: 'Patients reached', data: team.map(t => t.patients_reached), backgroundColor: 'rgba(23,173,180,0.6)', borderColor: CHART_COLORS.accent, borderWidth: 1, borderRadius: 5, maxBarThickness: 20 },
            { label: '1:1 sessions held', data: team.map(t => t.sessions_held), backgroundColor: 'rgba(46,125,85,0.6)', borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 5, maxBarThickness: 20 },
          ],
        }, { ...liveAnim(), plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } } } });
        const active = team.filter(t => t.checkins > 0);
        const idle = team.length - active.length;
        const top = team[0];
        setStory('chart-nutrition-team',
          `<strong>${fmtIN(totalCheckins)}</strong> check-in${totalCheckins === 1 ? '' : 's'} in the last ${rangeLabel()}` +
          (top && top.checkins ? `. <strong>${top.name}</strong> leads with ${fmtIN(top.checkins)}.` : '.') +
          (idle > 0 ? ` <strong>${idle}</strong> of ${team.length} nutritionists logged none. Worth a nudge: the worklist now shows everyone they can call.` : ''));
      }
    }
  } catch (err) { console.error('Nutrition section error:', err); }
}

// ── IMPACT ───────────────────────────────────────────────────

// Wellbeing over time: each measure normalised to a 0-100 "higher = better" index.
async function loadImpactTrend() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_impact_trend', { p_filters: F() });
    if (error) throw error;
    const rows = data || [];
    const canvas = document.getElementById('chart-impact-trend');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No wellbeing scores yet. They appear here as the team records them over time.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    const KEYS = ['qol_physical', 'qol_emotional', 'financial_toxicity', 'phq4_patient', 'activation'];
    const months = [...new Set(rows.map(r => r.month))].sort();
    const palette = [CHART_COLORS.success, CHART_COLORS.primary, CHART_COLORS.danger, CHART_COLORS.warning, CHART_COLORS.accent];
    const norm = (key, avg) => { const m = MEASURE_META[key]; if (!m) return null; const p = (avg / m.max) * 100; return Math.round(m.dir > 0 ? p : 100 - p); };
    const datasets = KEYS.filter(k => rows.some(r => r.measure === k)).map((k, i) => ({
      label: measureLabel(k),
      data: months.map(mo => { const r = rows.find(x => x.month === mo && x.measure === k); return r ? norm(k, Number(r.avg)) : null; }),
      borderColor: palette[i % palette.length], backgroundColor: 'transparent', tension: 0.35,
      spanGaps: true, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2,
    }));
    mkChart('chart-impact-trend', 'line', {
      labels: months.map(m => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); }),
      datasets,
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 10, font: { size: 11 } } } },
      interaction: { mode: 'index', intersect: false }, scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } },
    });
    setStory('chart-impact-trend',
      `How to read this: every measure is turned into a 0-100 "higher is better" index. Rising lines mean life is getting better; ` +
      `<strong>flat lines are also good news</strong>. In advanced cancer, a quality of life that holds steady month after month means the ground isn't giving way. Falling lines are the ones to act on.`);
  } catch (err) { console.error('Impact trend error:', err); }
}

// Improved / STABLE / declined per measure.
async function loadImpactImprove() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_wellbeing_trajectories', { p_filters: F() });
    if (error) throw error;
    const rows = (data?.measures || []).filter(r => r.patients > 0);
    const canvas = document.getElementById('chart-impact-improve');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>Need at least two check-ins per patient to show change. This chart fills in as follow-ups are logged.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    const teal = 'rgba(23,173,180,1)';
    mkChart('chart-impact-improve', 'bar', {
      labels: rows.map(r => measureLabel(r.measure)),
      datasets: [
        { label: 'Improved', data: rows.map(r => Number(r.improved)), backgroundColor: CHART_COLORS.success.replace('1)', '0.75)'), borderColor: CHART_COLORS.success, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
        { label: 'Stable (QoL holding)', data: rows.map(r => Number(r.stable)), backgroundColor: teal.replace('1)', '0.55)'), borderColor: teal, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
        { label: 'Declined', data: rows.map(r => Number(r.declined)), backgroundColor: CHART_COLORS.danger.replace('1)', '0.6)'), borderColor: CHART_COLORS.danger, borderWidth: 1, borderRadius: 4, maxBarThickness: 22 },
      ],
    }, {
      ...liveAnim(),
      indexAxis: 'y',
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { afterBody: (items) => { const r = rows[items[0].dataIndex]; return `${r.patients} patients · avg gain ${r.avg_gain} · watched ~${r.avg_window_days} days over ~${r.avg_checkins} check-ins`; } } } },
      scales: { x: { stacked: true }, y: { stacked: true } },
    });
    const o = data?.overall;
    if (o?.patients) {
      P.impact = { patients: Number(o.patients), holdingPct: pct(o.holding_or_up, o.patients), declined: Number(o.declined) };
      setStory('chart-impact-improve',
        `<strong>${pct(o.holding_or_up, o.patients)}% of the ${fmtIN(o.patients)} patients we track over time are holding steady or better</strong> on the measures we repeat. ` +
        `In advanced cancer that stability IS the outcome, quality of life not collapsing under treatment. ` +
        `${o.declined} patient${o.declined === 1 ? '' : 's'} declined meaningfully on at least one measure. Those are this week's closer look.`);
    }
  } catch (err) { console.error('Impact trajectories error:', err); }
}

async function loadImpactDeltas() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_impact_deltas', { p_filters: F() });
    if (error) throw error;
    const canvas = document.getElementById('chart-impact');
    if (!canvas) return;
    if (!data || data.length === 0) {
      canvas.closest('.chart-card').insertAdjacentHTML('beforeend',
        '<div class="empty" style="padding:var(--s5) 0"><p>No wellbeing scores yet. Record baselines on patient pages (Wellbeing tab) and the change will show here.</p></div>');
      (canvas.closest('.chart-canvas-wrap')||canvas).remove();
      return;
    }
    mkChart('chart-impact', 'bar', {
      labels: data.map(d => measureLabel(d.measure)),
      datasets: [
        { label: 'Baseline', data: data.map(d => d.avg_baseline),
          backgroundColor: 'rgba(123,135,131,0.45)', borderColor: 'rgba(123,135,131,1)', borderWidth: 1, borderRadius: 5, maxBarThickness: 26 },
        { label: 'Latest', data: data.map(d => d.avg_latest),
          backgroundColor: CHART_COLORS.primary.replace('1)', '0.65)'), borderColor: CHART_COLORS.primary, borderWidth: 1, borderRadius: 5, maxBarThickness: 26 },
      ],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } } },
    });
    setStory('chart-impact',
      `Baseline is the first score we ever recorded; latest is where the patient stands now. ` +
      `For distress measures (PHQ-4, financial toxicity, burden) a LOWER "latest" bar is the win; for QoL and activation, higher. ` +
      `Bars that barely move on the distress measures while treatment continues are quiet successes.`);
  } catch (err) { console.error('Impact deltas error:', err); }
}

// IMPACT crosstabs: financial toxicity by income band, activation distribution.
async function loadImpactCross() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_impact_crosstabs', { p_filters: F() });
    if (error) throw error;
    const fx = data?.fintox_by_economic || [];
    if (fx.length) {
      const lbl = { bpl: 'BPL', lower_middle: 'Lower middle', middle: 'Middle', upper_middle: 'Upper middle', unknown: 'Unknown' };
      mkChart('chart-fintox-economic', 'bar', {
        labels: fx.map(x => lbl[x.economic_status] || capitalize(x.economic_status || 'unknown')),
        datasets: [{ data: fx.map(x => Number(x.avg)), backgroundColor: CHART_COLORS.danger.replace('1)', '0.55)'), borderColor: CHART_COLORS.danger, borderWidth: 1, borderRadius: 6, maxBarThickness: 38 }],
      }, { ...liveAnim(), plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `avg ${ctx.parsed.y}/10 toxicity · n=${fx[ctx.dataIndex].n}` } } }, scales: { y: { max: 10 } } });
      const known = fx.filter(x => x.economic_status && x.economic_status !== 'unknown');
      const worst = [...known].sort((a, b) => Number(b.avg) - Number(a.avg))[0];
      if (worst) {
        const lblOf = (k) => lbl[k] || capitalize(k);
        setStory('chart-fintox-economic',
          `Financial toxicity is heaviest for <strong>${lblOf(worst.economic_status)}</strong> households (avg ${worst.avg}/10). ` +
          `If the poorest bands score highest, treatment costs are landing exactly where there's least cushion. That's the queue for aid navigation and the resources directory.`);
      }
    }
    const act = data?.activation_dist || [];
    if (act.length) {
      mkChart('chart-activation', 'bar', {
        labels: act.map(x => 'Level ' + x.score),
        datasets: [{ data: act.map(x => Number(x.n)), backgroundColor: CHART_COLORS.primary.replace('1)', '0.6)'), borderColor: CHART_COLORS.primary, borderWidth: 1, borderRadius: 6, maxBarThickness: 40 }],
      }, { ...liveAnim(), plugins: { legend: { display: false } }, scales: { y: { ticks: { precision: 0 } } } });
      const total = act.reduce((a, x) => a + Number(x.n), 0);
      const low = act.filter(x => Number(x.score) <= 2).reduce((a, x) => a + Number(x.n), 0);
      setStory('chart-activation',
        `Activation asks: "if something goes wrong, do you know what to do?" ` +
        `<strong>${fmtIN(low)} of ${fmtIN(total)} scored patients (${pct(low, total)}%) sit at level 1-2</strong>. They wouldn't know whom to call in a crisis. ` +
        `Every navigation call that ends with "save this number" moves this chart.`);
    }
  } catch (err) { console.error('IMPACT crosstab error:', err); }
}

// ── CORRELATE ────────────────────────────────────────────────

async function loadDoseResponse() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_support_dose_response', { p_filters: F() });
    if (error) throw error;
    const rows = data || [];
    const canvas = document.getElementById('chart-dose-response');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>Needs repeat check-ins plus recorded support levers. This chart fills in as both grow.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    mkChart('chart-dose-response', 'bar', {
      labels: rows.map(r => r.dose),
      datasets: [{
        data: rows.map(r => Number(r.avg_gain_pct)),
        backgroundColor: rows.map(r => (Number(r.avg_gain_pct) >= 0 ? CHART_COLORS.success : CHART_COLORS.danger).replace('1)', '0.6)')),
        borderColor: rows.map(r => Number(r.avg_gain_pct) >= 0 ? CHART_COLORS.success : CHART_COLORS.danger),
        borderWidth: 1, borderRadius: 6, maxBarThickness: 42,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => { const r = rows[ctx.dataIndex]; return [`avg change ${r.avg_gain_pct > 0 ? '+' : ''}${r.avg_gain_pct}% of scale`, `${r.holding_or_up} of ${r.patients} holding or better`]; } } } },
      scales: { y: { title: { display: true, text: 'avg well-being change (% of scale)' } } },
    });
    const none = rows.find(r => r.dose === 'No support yet');
    const most = rows.find(r => r.dose === '3+ levers');
    if (none && most) {
      const diff = (Number(most.avg_gain_pct) - Number(none.avg_gain_pct)).toFixed(1);
      P.dose = { diff: Number(diff) };
      setStory('chart-dose-response',
        `Patients who received <strong>3+ support levers</strong> trend <strong>${diff > 0 ? '+' + diff : diff} points of scale</strong> versus those with none ` +
        `(${most.avg_gain_pct > 0 ? '+' : ''}${most.avg_gain_pct}% vs ${none.avg_gain_pct > 0 ? '+' : ''}${none.avg_gain_pct}%). ` +
        `${diff > 0 ? 'The support is moving with the outcome, the correlation the abstract needs.' : 'No dose-response yet: worth checking whether the sickest patients are the ones getting the most support (confounding), or whether levers need to land earlier.'}`);
    }
  } catch (err) { console.error('Dose-response error:', err); }
}

async function loadWarmingCurve() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_receptiveness_by_call', { p_filters: F() });
    if (error) throw error;
    const rows = data || [];
    const canvas = document.getElementById('chart-warming');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No receptiveness data yet.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    const series = [
      { key: 'warm', label: 'Warm', color: CHART_COLORS.success },
      { key: 'neutral', label: 'Neutral', color: CHART_COLORS.info },
      { key: 'guarded', label: 'Guarded', color: CHART_COLORS.warning },
      { key: 'overwhelmed', label: 'Overwhelmed', color: CHART_COLORS.slate },
    ];
    mkChart('chart-warming', 'bar', {
      labels: rows.map(r => r.call_n),
      datasets: series.map(s => ({
        label: s.label,
        data: rows.map(r => pct(Number(r[s.key]), Number(r.calls))),
        backgroundColor: s.color.replace('1)', '0.65)'), borderColor: s.color, borderWidth: 1, maxBarThickness: 34,
      })),
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}% of ${rows[ctx.dataIndex].calls} calls` } } },
      scales: { x: { stacked: true }, y: { stacked: true, max: 100, ticks: { callback: (v) => v + '%' } } },
    });
    const first = rows[0], last = rows[rows.length - 1];
    if (first && last && rows.length > 1) {
      const w1 = pct(Number(first.warm), Number(first.calls));
      const wN = pct(Number(last.warm), Number(last.calls));
      P.warming = { w1, wN, lastLabel: last.call_n };
      setStory('chart-warming',
        `On the first conversation <strong>${w1}%</strong> of patients are warm; by ${last.call_n.toLowerCase()} it's <strong>${wN}%</strong>. ` +
        (wN > w1 ? 'Families warm up as the relationship grows. The repeat-call model is doing its job.'
                 : 'Warmth is not climbing across calls yet. Worth reviewing what happens between call 1 and the follow-ups.'));
    }
  } catch (err) { console.error('Warming curve error:', err); }
}

async function loadTrustCurve() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_completeness_by_trust', { p_filters: F() });
    if (error) throw error;
    const rows = data || [];
    const canvas = document.getElementById('chart-trust');
    if (!canvas) return;
    if (!rows.length) { canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>No data yet.</p></div>'); (canvas.closest('.chart-canvas-wrap')||canvas).remove(); return; }
    mkChart('chart-trust', 'bar', {
      labels: rows.map(r => r.band),
      datasets: [{
        data: rows.map(r => Number(r.pct_complete)),
        backgroundColor: rows.map(r => (Number(r.pct_complete) >= 75 ? CHART_COLORS.success : Number(r.pct_complete) >= 40 ? CHART_COLORS.warning : CHART_COLORS.danger).replace('1)', '0.6)')),
        borderColor: rows.map(r => Number(r.pct_complete) >= 75 ? CHART_COLORS.success : Number(r.pct_complete) >= 40 ? CHART_COLORS.warning : CHART_COLORS.danger),
        borderWidth: 1, borderRadius: 6, maxBarThickness: 42,
      }],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y}% of 8 key details known · ${rows[ctx.dataIndex].patients} patients` } } },
      scales: { y: { max: 100, ticks: { callback: (v) => v + '%' }, title: { display: true, text: '8 key details known' } } },
    });
    const zero = rows.find(r => r.band === 'Not reached yet');
    const three = rows.find(r => r.band === '3+ conversations');
    if (three) {
      setStory('chart-trust',
        `Families don't share everything at once, and they don't have to. After <strong>3+ real conversations</strong> we know ` +
        `<strong>${three.pct_complete}%</strong> of the key details${zero ? `, versus ${zero.pct_complete}% before first contact` : ''}. ` +
        `Every gentle call closes the gap; the "Ask today" panel on the portal is how.`);
    }
  } catch (err) { console.error('Trust curve error:', err); }
}

// ── Gender: patient vs. primary caregiver (a real story for doctors) ──
async function loadGenderSplit() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_patient_demographics', { p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    // Fold the enum into three visible buckets; keep "not recorded" aside.
    const bucket = (rows) => {
      const g = Object.fromEntries((rows || []).map(x => [x.gender, Number(x.n)]));
      return {
        women: g.female || 0, men: g.male || 0, other: g.other || 0,
        na: (g.prefer_not_to_say || 0) + (g.unrecorded || 0) + (g.unknown || 0),
      };
    };
    const pt = bucket(data.gender);
    const cg = bucket(data.caregiver_gender);
    const cats = ['Women', 'Men', 'Other'];
    const canvas = document.getElementById('chart-gender');
    if (!canvas) return;
    mkChart('chart-gender', 'bar', {
      labels: cats,
      datasets: [
        { label: 'Patient', data: [pt.women, pt.men, pt.other],
          backgroundColor: 'rgba(12,110,116,0.62)', borderColor: CHART_COLORS.primary, borderWidth: 1, borderRadius: 5, maxBarThickness: 34 },
        { label: 'Primary caregiver', data: [cg.women, cg.men, cg.other],
          backgroundColor: 'rgba(23,173,180,0.6)', borderColor: CHART_COLORS.accent, borderWidth: 1, borderRadius: 5, maxBarThickness: 34 },
      ],
    }, {
      ...liveAnim(),
      plugins: { legend: { display: true, labels: { boxWidth: 8, padding: 12, font: { size: 11 } } } },
      scales: { y: { ticks: { precision: 0 } } },
      filterOn: { facet: 'gender', values: ['female', 'male', 'other'] },
    });
    const ptTot = pt.women + pt.men + pt.other;
    const cgKnown = cg.women + cg.men + cg.other;
    const flip = ptTot && cgKnown
      ? `On the caregiver side it often flips: <strong>${pct(cg.women, cgKnown)}% of primary caregivers are women</strong>, the daughter, wife or daughter-in-law who quietly carries the load.`
      : '';
    setStory('chart-gender',
      `${ptTot ? `<strong>${pct(pt.women, ptTot)}% of patients are women, ${pct(pt.men, ptTot)}% men.</strong> ` : ''}` +
      flip +
      `${cg.na ? ` Caregiver gender is still unrecorded for ${fmtIN(cg.na)} families. It now appears as a one-tap question in the calling portal, so this fills in over the coming weeks.` : (cgKnown ? '' : ' Caregiver gender starts populating as the team records it on calls.')}`);
  } catch (err) { console.error('Gender split error:', err); }
}

// ── Financial help: the actual sources, and sent→availed conversion ──
async function loadFinancialSources() {
  const sb = getSupabase();
  const fmtRs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  try {
    const { data, error } = await sb.rpc('get_financial_sources', { p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    const canvas = document.getElementById('chart-financial-sources');
    if (!canvas) return;
    const named = (data.by_source || []).filter(s => s.source && s.source !== 'Source not recorded' && Number(s.families) > 0);
    // Header badge: sent → availed conversion. Guard against the 60s auto-refresh
    // re-inserting it (the header HTML isn't rebuilt between live refreshes).
    const finHeader = document.getElementById('chart-financial-sources')?.closest('.chart-card').querySelector('.chart-header');
    const finBadge = finHeader?.querySelector('.js-fin-conv');
    const finBadgeHTML = `<span class="badge badge-ok js-fin-conv" title="Of families sent financial resources, the share who went on to actually avail aid">${data.conversion || 0}% sent → availed</span>`;
    if (finBadge) finBadge.outerHTML = finBadgeHTML;
    else finHeader?.insertAdjacentHTML('beforeend', finBadgeHTML);

    if (named.length >= 2) {
      // The real ask: which sources families actually availed.
      mkChart('chart-financial-sources', 'bar', {
        labels: named.map(s => s.source),
        datasets: [{
          label: 'Families helped', data: named.map(s => Number(s.families)),
          backgroundColor: 'rgba(12,110,116,0.6)', borderColor: CHART_COLORS.primary,
          borderWidth: 1, borderRadius: 5, maxBarThickness: 26,
        }],
      }, {
        ...liveAnim(), indexAxis: 'y',
        plugins: { legend: { display: false },
          tooltip: { callbacks: { afterLabel: (ctx) => { const s = named[ctx.dataIndex]; return Number(s.total) ? `${fmtRs(s.total)} disbursed through this source` : ''; } } } },
      });
    } else {
      // Fall back to the funnel when specific sources aren't captured yet.
      const f = data.funnel || [];
      mkChart('chart-financial-sources', 'bar', {
        labels: f.map(x => x.stage),
        datasets: [{
          data: f.map(x => Number(x.n)),
          backgroundColor: ['rgba(12,110,116,0.3)', 'rgba(12,110,116,0.6)', 'rgba(23,173,180,0.55)', 'rgba(46,125,85,0.5)'],
          borderColor: CHART_COLORS.primary, borderWidth: 1, borderRadius: 5, maxBarThickness: 30,
        }],
      }, { ...liveAnim(), indexAxis: 'y', plugins: { legend: { display: false } } });
    }
    const dir = data.directory || [];
    const dirTotal = dir.reduce((a, d) => a + Number(d.n), 0);
    setStory('chart-financial-sources',
      `<strong>${fmtIN(data.sent || 0)} families were sent financial resources</strong> and <strong>${fmtIN(data.availed || 0)} went on to actually avail aid (${data.conversion || 0}% conversion)</strong>` +
      `${Number(data.total_aid) ? `, moving <strong>${fmtRs(data.total_aid)}</strong> to ${fmtIN(data.aid_families)} households` : ''}. ` +
      (named.length >= 2
        ? `The sources families drew on most are <strong>${named[0].source}</strong> (${named[0].families})${named[1] ? ` and ${named[1].source} (${named[1].families})` : ''}. `
        : `The specific scheme isn't captured on most records yet. Logging the source name when aid is availed will let this break down by fund. `) +
      `${dirTotal ? `The resources library holds ${fmtIN(dirTotal)} financial/practical options ready to send.` : ''}`);
  } catch (err) { console.error('Financial sources error:', err); }
}

// ── Cohort wellbeing trend: the honest, cohort-isolated view ──
let cohortSel = 'all';   // persists across live refreshes
async function loadCohortTrend() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_cohort_wellbeing_trend', { p_filters: F() });
    if (error) throw error;
    if (!data || data.error) return;
    const cohorts = (data.cohorts || []).filter(c => (c.points || []).length);
    const canvas = document.getElementById('chart-cohort-trend');
    if (!canvas) return;
    if (!cohorts.length) {
      canvas.closest('.chart-card').querySelector('#cohort-chips')?.remove();
      canvas.closest('.chart-card').insertAdjacentHTML('beforeend', '<div class="empty" style="padding:var(--s5) 0"><p>Not enough repeat wellbeing scores yet to trace cohorts. This lights up as the team re-checks patients over time.</p></div>');
      (canvas.closest('.chart-canvas-wrap') || canvas).remove();
      return;
    }
    P.cohortData = data;
    if (cohortSel !== 'all' && !cohorts.some(c => c.cohort === cohortSel)) cohortSel = 'all';

    const monLabel = (m) => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); };

    // Chips: All + each cohort with its size.
    const chipsEl = document.getElementById('cohort-chips');
    if (chipsEl) {
      chipsEl.innerHTML = `<button class="cohort-chip ${cohortSel === 'all' ? 'on' : ''}" data-cohort="all">All cohorts</button>` +
        cohorts.map(c => `<button class="cohort-chip ${cohortSel === c.cohort ? 'on' : ''}" data-cohort="${c.cohort}">${monLabel(c.cohort)}<span class="cc-n">${c.cohort_n}</span></button>`).join('');
      chipsEl.querySelectorAll('.cohort-chip').forEach(b => b.addEventListener('click', () => {
        cohortSel = b.dataset.cohort;
        chipsEl.querySelectorAll('.cohort-chip').forEach(x => x.classList.toggle('on', x.dataset.cohort === cohortSel));
        drawCohort();
      }));
    }
    drawCohort();
  } catch (err) { console.error('Cohort trend error:', err); }
}

function drawCohort() {
  const data = P.cohortData; if (!data) return;
  const cohorts = (data.cohorts || []).filter(c => (c.points || []).length);
  const months = data.months || [];
  const monLabel = (m) => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); };
  const palette = [CHART_COLORS.primary, CHART_COLORS.success, CHART_COLORS.accent, '#5B4892', CHART_COLORS.warning, '#356690', CHART_COLORS.danger, '#9C5A3C'];
  const isAll = cohortSel === 'all';
  const datasets = cohorts.map((c, i) => {
    const on = isAll || c.cohort === cohortSel;
    const col = palette[i % palette.length];
    const pts = Object.fromEntries((c.points || []).map(p => [p.month, Number(p.index)]));
    return {
      label: monLabel(c.cohort) + ' cohort',
      data: months.map(m => pts[m] ?? null),
      borderColor: on ? col : 'rgba(123,135,131,0.28)',
      backgroundColor: 'transparent',
      borderWidth: on ? (isAll ? 2 : 3) : 1.2,
      tension: 0.35, spanGaps: true,
      pointRadius: on ? 3 : 0, pointHoverRadius: 6,
      order: on ? 0 : 2,
    };
  });
  mkChart('chart-cohort-trend', 'line', {
    labels: months.map(monLabel), datasets,
  }, {
    ...liveAnim(),
    plugins: {
      legend: { display: true, labels: { boxWidth: 8, padding: 9, font: { size: 10.5 }, filter: (it) => cohortSel === 'all' || it.text.startsWith(monLabelSafe()) } },
      tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => ctx.parsed.y == null ? null : `${ctx.dataset.label}: ${ctx.parsed.y}/100` } },
    },
    interaction: { mode: 'nearest', intersect: false },
    scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' }, title: { display: true, text: 'wellbeing index (higher = better)' } } },
  });

  // Story tailored to the selection.
  function monLabelSafe() { if (cohortSel === 'all') return ''; return monLabel(cohortSel); }
  if (cohortSel === 'all') {
    setStory('chart-cohort-trend',
      `Each line is one monthly intake cohort, followed only among its own patients. <strong>Click a month to isolate it.</strong> ` +
      `When a cohort's line climbs or holds, that IS the program working, the same families getting better or staying stable. ` +
      `The pooled chart below can't show this: it keeps mixing in new arrivals whose scores start low.`);
  } else {
    const c = cohorts.find(x => x.cohort === cohortSel);
    const pts = (c?.points || []);
    if (pts.length >= 2) {
      const first = pts[0], last = pts[pts.length - 1];
      const delta = Math.round(Number(last.index) - Number(first.index));
      setStory('chart-cohort-trend',
        `The <strong>${monLabel(cohortSel)}</strong> cohort (${c.cohort_n} patients) started at a <strong>${first.index}/100</strong> wellbeing index and is now at <strong>${last.index}/100</strong>, ` +
        (delta > 2 ? `up ${delta} points. This cohort is genuinely improving.`
          : delta < -2 ? `down ${Math.abs(delta)} points. This cohort needs a closer look; the concerns queue should already reflect the worst of it.`
          : `essentially holding steady. In advanced cancer, a flat line over months is a real win, not a null result.`));
    } else if (pts.length === 1) {
      setStory('chart-cohort-trend', `The <strong>${monLabel(cohortSel)}</strong> cohort (${c.cohort_n} patients) has one month of scores so far at <strong>${pts[0].index}/100</strong>. The trend appears once they're re-checked.`);
    }
  }
}

// ── SECTION INSIGHTS: what the charts of each band say together ──
function renderSectionInsights() {
  const c = P.pulse?.curr || {};
  // REACH
  {
    const bits = [];
    if (P.pulse) bits.push(`We're caring for <strong>${fmtIN(P.pulse.total_patients)} active people</strong>${P.intake ? `, ${fmtIN(P.intake.window_new)} of whom arrived in the last ${rangeLabel()}` : ''}.`);
    if (P.reachSubtype?.top) bits.push(`The registry is dominated by <strong>${P.reachSubtype.top}</strong> cancers${P.reachStage?.known ? `, and ${pct(P.reachStage.late, P.reachStage.known)}% of staged patients were already stage III/IV when we met them` : ''}.`);
    if (P.reachVuln?.total) bits.push(`<strong>${pct(P.reachVuln.high, P.reachVuln.total)}% of households are highly vulnerable</strong>. The reach isn't just wide, it's aimed at the people with the least cushion.`);
    setSectionInsight('reach', bits.join(' '));
  }
  // ACTION
  {
    const bits = [];
    if (P.calls) bits.push(`In the last ${rangeLabel()} the team put in <strong>${fmtIN(P.calls.totalCalls)} dials for ${fmtIN(P.calls.conn)} real conversations (${pct(P.calls.conn, P.calls.totalCalls)}%)</strong>${P.outcomes?.avgTalk ? `, averaging ${P.outcomes.avgTalk} minutes each` : ''}.`);
    if (P.bestTime) bits.push(`Connection peaks around <strong>${P.bestTime.hour > 12 ? P.bestTime.hour - 12 + ' pm' : P.bestTime.hour + ' am'}</strong>. Schedule the hard-to-reach families there.`);
    if (P.levers) bits.push(`Conversation is turning into help: <strong>${fmtIN(P.levers.delivered)} support levers delivered</strong>${P.levers.top ? `, led by ${P.levers.top.toLowerCase()}` : ''}${P.quality?.whatsapp ? `, and ${fmtIN(P.quality.whatsapp)} families joined the WhatsApp community in this window` : ''}.`);
    if (P.pipeline) bits.push(`The 1:1 pipeline holds <strong>${fmtIN(P.pipeline.live)} live invitations</strong> with ${fmtIN(P.pipeline.heldWindow)} sessions held in the window${P.equity && !P.equity.fair ? `. ⚠ The equity chart says high-need families are getting less than low-need ones. That's the correction to make first` : ''}.`);
    setSectionInsight('action', bits.join(' '));
  }
  // SAFETY NET
  if (P.concerns) {
    const openTotal = (P.concerns.backlog || []).reduce((a, b) => a + Number(b.n), 0);
    setSectionInsight('safetynet',
      `<strong>${fmtIN(P.concerns.opened)} red flags were caught in the last ${rangeLabel()}</strong>` +
      `${P.concerns.auto ? ` (${P.concerns.auto}% automatically, from assessment thresholds)` : ''} and <strong>${fmtIN(openTotal)} are still waiting</strong>. ` +
      (P.concerns.resolved
        ? `Resolution is happening (${fmtIN(P.concerns.resolved)} closed${P.concerns.median != null ? `, median ${P.concerns.median} days` : ''}). Keep the loop tight.`
        : `Catching is working; <strong>closing isn't happening yet</strong>. Someone needs to own the triage loop this week.`));
  }
  // NUTRITION
  if (P.nutrition) {
    setSectionInsight('nutrition',
      `<strong>${fmtIN(P.nutrition.touched)} patients</strong> have nutrition work on file and ${fmtIN(P.nutrition.plan)} hold a diet plan, ` +
      `but <strong>${fmtIN(P.nutrition.high)} are at high malnutrition risk</strong> and ${fmtIN(P.nutrition.unscreened)} still have no MUST screen. ` +
      `Screen the unscreened first: it's one number that instantly sorts who needs the team most.`);
  }
  // IMPACT
  if (P.impact) {
    setSectionInsight('impact',
      `Across everyone we track over time, <strong>${P.impact.holdingPct}% are holding steady or improving</strong>. In advanced cancer, that stability is the win. ` +
      `${P.impact.declined ? `<strong>${fmtIN(P.impact.declined)} patients declined meaningfully</strong>. They are this week's priority list, and the concerns queue should already have flagged the worst of them.` : ''}`);
  }
  // CORRELATE
  {
    const bits = [];
    if (P.dose) bits.push(P.dose.diff > 0
      ? `The dose-response is positive: <strong>more support tracks with better wellbeing</strong> (+${P.dose.diff} points of scale for 3+ levers vs none).`
      : `No positive dose-response yet. The likeliest reading is that support flows to the sickest (confounding), not that support fails.`);
    if (P.warming) bits.push(`And the relationship itself works: warmth goes from ${P.warming.w1}% on call one to <strong>${P.warming.wN}% by ${String(P.warming.lastLabel).toLowerCase()}</strong>. Patience, not pitch, is the method.`);
    setSectionInsight('correlate', bits.join(' '));
  }
}
