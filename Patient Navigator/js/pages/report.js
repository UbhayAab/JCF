// ============================================================
// Patient Navigator - Monthly Impact Report
// An institutional, print-to-PDF impact report. Front-loads the
// conclusion, states denominators and n= throughout, keeps outputs
// (calls, support) separate from outcomes (wellbeing change), and
// puts methodology early. One accent (teal), neutral ground, tabular
// figures, month-on-month context. Charts are inline SVG so they stay
// crisp in print. "Download PDF" uses the browser's print-to-PDF.
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { giLabel, measureLabel, leverLabel, INSTRUMENTS } from '../utils/catalog.js';
import { exportToCSV } from '../utils/formatters.js';

let reportMonths = null;   // [{value:'YYYY-MM-01', label, calls}]
let selectedMonth = null;  // 'YYYY-MM-01' or null (=current)
const STYLE_ID = 'impact-report-style';
const A = '#0C6E74';            // single accent
const GRID = '#E3E9E7';

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;
const monthName = (d) => new Date(d).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

// financial-aid guidance levers (aid is logged as guidance, not disbursed rupees)
const FIN_LEVERS = new Set(['financial_resources_sent', 'financial_aid_guidance', 'financial_aid', 'scheme_enrolled']);

// ---------- inline SVG chart helpers (crisp in print) ----------
function spark(vals, w = 88, h = 24) {
  const v = vals.map(Number); const mx = Math.max(...v, 1); const mn = Math.min(...v, 0);
  const rng = (mx - mn) || 1; const step = v.length > 1 ? w / (v.length - 1) : w;
  const pts = v.map((n, i) => `${(i * step).toFixed(1)},${(h - ((n - mn) / rng) * (h - 3) - 1.5).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${A}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="1.9" fill="${A}"/></svg>`;
}
// vertical columns with value labels; last column emphasised
function columns(rows, { w = 300, h = 120, unit = '' } = {}) {
  const v = rows.map(r => Number(r.v)); const mx = Math.max(...v, 1);
  const n = rows.length; const gap = 10; const bw = (w - gap * (n - 1)) / n; const top = 18; const bh = h - top - 20;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img">
    ${rows.map((r, i) => {
      const bar = Math.max(1, (Number(r.v) / mx) * bh); const x = i * (bw + gap); const y = top + (bh - bar); const emph = i === n - 1;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bar.toFixed(1)}" rx="2" fill="${emph ? A : '#CBD8D6'}"/>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="9" font-family="'Spline Sans Mono',monospace" fill="${emph ? A : '#4B5754'}">${fmt(r.v)}${unit}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(h - 6).toFixed(1)}" text-anchor="middle" font-size="9" fill="#7B8783">${r.label}</text>`;
    }).join('')}</svg>`;
}
// horizontal bars: {label, v, sub}
function hbars(rows, { max = null, unit = '', accentFirst = false } = {}) {
  const mx = max || Math.max(...rows.map(r => Number(r.v)), 1);
  return `<div class="ir-hbars">${rows.map((r, i) => `
    <div class="ir-hbar">
      <div class="ir-hbar-l">${r.label}</div>
      <div class="ir-hbar-track"><div class="ir-hbar-fill" style="width:${Math.max(2, (Number(r.v) / mx) * 100).toFixed(1)}%;background:${accentFirst && i === 0 ? A : '#9CC0BD'}"></div></div>
      <div class="ir-hbar-v">${fmt(r.v)}${unit}${r.sub ? `<span class="ir-hbar-sub"> ${r.sub}</span>` : ''}</div>
    </div>`).join('')}</div>`;
}
// delta chip: signed change vs previous month (neutral - direction, not judgement)
function delta(cur, prev, { unit = '', money: isMoney = false } = {}) {
  const d = Number(cur) - Number(prev);
  if (!prev && !cur) return `<span class="ir-delta ir-flat">no data</span>`;
  if (d === 0) return `<span class="ir-delta ir-flat">no change</span>`;
  const arrow = d > 0 ? '▲' : '▼';
  const val = isMoney ? money(Math.abs(d)) : fmt(Math.abs(d)) + unit;
  return `<span class="ir-delta ${d > 0 ? 'ir-up' : 'ir-down'}">${arrow} ${val} <span class="ir-delta-vs">vs last mo.</span></span>`;
}

function kpiTile({ label, value, unit = '', foot, cur, prev, sparkVals, isMoney = false }) {
  return `<div class="ir-kpi">
    <div class="ir-kpi-label">${label}</div>
    <div class="ir-kpi-num">${isMoney ? money(value) : fmt(value)}<span class="ir-kpi-unit">${unit}</span></div>
    <div class="ir-kpi-row">${delta(cur, prev, { isMoney })}${sparkVals ? `<span class="ir-kpi-spark">${spark(sparkVals)}</span>` : ''}</div>
    ${foot ? `<div class="ir-kpi-foot">${foot}</div>` : ''}
  </div>`;
}

export async function renderReport(container, testPayload) {
  if (!testPayload && !isManagerOrAdmin()) { container.innerHTML = `<div class="empty"><h4>Managers only</h4></div>`; return; }
  injectStyle();
  if (testPayload) { paint(container, testPayload); return; }
  container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-3)">Compiling the impact report...</div>`;

  let payload;
  try {
    if (!reportMonths) {
      try { const { data: mo } = await getSupabase().rpc('get_report_months'); reportMonths = mo || []; } catch { reportMonths = []; }
    }
    const { data, error } = await getSupabase().rpc('get_impact_report', selectedMonth ? { p_month: selectedMonth } : {});
    if (error) throw error;
    payload = data;
  } catch (e) {
    container.innerHTML = `<div class="empty"><div class="ico-wrap"></div><h4>Could not build the report</h4><p>${e.message}</p></div>`;
    return;
  }
  paint(container, payload);
}

function paint(container, d) {
  const k = d.kpi || {}; const trend = d.trend || []; const wb = d.wellbeing || [];
  const cov = d.coverage || []; const mix = d.call_mix || []; const cohort = d.cohort || {};
  const period = d.period || {};
  const tCalls = trend.map(t => t.calls), tConn = trend.map(t => t.connected), tReach = trend.map(t => t.reached),
    tSupport = trend.map(t => t.support), tAssess = trend.map(t => t.assessments), tNew = trend.map(t => t.new_patients);

  const connRateCur = pct(k.connected?.v, k.calls?.v);
  const connRatePrev = pct(k.connected?.prev, k.calls?.prev);
  const finGuided = cov.filter(c => FIN_LEVERS.has(c.lever)).reduce((a, c) => a + Number(c.n), 0);
  const totalMix = mix.reduce((a, m) => a + Number(m.n), 0);

  // wellbeing: keep measures with a real sample (n>=5), show improved% + n=
  const wbShown = wb.filter(w => w.reassessed >= 5).sort((a, b) => b.reassessed - a.reassessed);
  const wbHeadline = wbShown.length
    ? wbShown.reduce((best, w) => pct(w.improved, w.reassessed) > pct(best.improved, best.reassessed) ? w : best, wbShown[0])
    : null;

  const OUTCOME = { connected: 'Connected', no_answer: 'No answer', busy: 'Busy', callback_requested: 'Callback requested', voicemail: 'Voicemail', wrong_number: 'Wrong number' };

  // executive summary (data-driven, plain prose)
  const summary = `In ${period.label}, the team placed <b>${fmt(k.calls?.v)}</b> calls and connected with <b>${fmt(k.reached?.v)}</b> families (${connRateCur}% of calls connected). ` +
    `<b>${fmt(k.support?.v)}</b> concrete supports were delivered - resources shared, guidance given and referrals made - and <b>${fmt(k.assessments?.v)}</b> well-being check-ins were recorded. ` +
    (wbHeadline ? `Among patients re-assessed to date on ${measureLabel(wbHeadline.measure)}, <b>${pct(wbHeadline.improved, wbHeadline.reassessed)}%</b> improved (n=${wbHeadline.reassessed}). ` : '') +
    `${fmt(k.new_patients?.v)} new families joined our care this month.`;

  container.innerHTML = `
  <div class="ir-bar ir-noprint">
    <div>
      <div class="ir-bar-t">Monthly Impact Report</div>
      <div class="ir-bar-s">Built from live data · pick a month to regenerate</div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <select class="select" id="ir-month" title="Choose the reporting month" style="width:auto;padding:8px 30px 8px 12px;font-size:13px;min-width:150px">
        ${(reportMonths || []).map(mo => `<option value="${mo.value}" ${mo.value === period.m0 ? 'selected' : ''}>${mo.label} · ${fmt(mo.calls)} calls</option>`).join('') || `<option>${period.label}</option>`}
      </select>
      <button class="btn btn-secondary" id="ir-data" title="Download this month's numbers as CSV sheets">${sheetIcon()} Download data</button>
      <button class="btn btn-primary" id="ir-pdf">${dlIcon()} Download PDF</button>
    </div>
  </div>

  <div class="ir" id="ir-doc">
    <div class="ir-runhead">Jarurat Care · Monthly Impact Report · ${period.label}</div>

    <!-- COVER -->
    <section class="ir-cover ir-page">
      <div class="ir-cover-top">
        <span class="ir-mark">${heart()}</span>
        <div><div class="ir-mark-name">Jarurat Care</div><div class="ir-mark-sub">Patient Navigator</div></div>
      </div>
      <div class="ir-cover-mid">
        <div class="ir-eyebrow">Monthly Impact Report</div>
        <h1 class="ir-cover-title">${period.label}</h1>
        <div class="ir-cover-range">Reporting period ${period.range || ''}</div>
      </div>
      <div class="ir-cover-foot">
        <div><span class="ir-lbl">Prepared</span> ${new Date(d.generated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <div><span class="ir-lbl">Scope</span> Cancer-care navigation - calls, guidance, well-being</div>
        <div class="ir-conf">Confidential · for the Jarurat Care team and partners</div>
      </div>
    </section>

    <!-- EXECUTIVE SUMMARY -->
    <section class="ir-section">
      <h2 class="ir-h2"><span class="ir-num">01</span> At a glance</h2>
      <p class="ir-lead">${summary}</p>
    </section>

    <!-- KPI STRIP -->
    <section class="ir-section">
      <div class="ir-kpis">
        ${kpiTile({ label: 'Calls placed', value: k.calls?.v, cur: k.calls?.v, prev: k.calls?.prev, sparkVals: tCalls, foot: 'Outbound calls logged' })}
        ${kpiTile({ label: 'Families reached', value: k.reached?.v, cur: k.reached?.v, prev: k.reached?.prev, sparkVals: tReach, foot: 'Distinct families connected' })}
        ${kpiTile({ label: 'Connect rate', value: connRateCur, unit: '%', cur: connRateCur, prev: connRatePrev, sparkVals: trend.map(t => pct(t.connected, t.calls)), foot: 'Connected ÷ calls placed' })}
        ${kpiTile({ label: 'Support delivered', value: k.support?.v, cur: k.support?.v, prev: k.support?.prev, sparkVals: tSupport, foot: 'Resources, guidance, referrals' })}
        ${kpiTile({ label: 'Well-being check-ins', value: k.assessments?.v, cur: k.assessments?.v, prev: k.assessments?.prev, sparkVals: tAssess, foot: 'PHQ-4 / QoL / MUST / Zarit' })}
        ${kpiTile({ label: 'New families', value: k.new_patients?.v, cur: k.new_patients?.v, prev: k.new_patients?.prev, sparkVals: tNew, foot: 'Joined our care this month' })}
        ${kpiTile({ label: 'Financial-aid guidance', value: finGuided, cur: finGuided, prev: 0, sparkVals: null, foot: 'Families guided to schemes / aid' })}
        ${kpiTile({ label: '1:1 sessions held', value: k.sessions?.v, cur: k.sessions?.v, prev: k.sessions?.prev, sparkVals: null, foot: 'Nutrition / well-being sessions' })}
      </div>
      <p class="ir-note">Outputs (calls, support delivered) are shown separately from outcomes (change in well-being, below). Deltas compare with the previous calendar month.</p>
    </section>

    <!-- METHODOLOGY -->
    <section class="ir-section ir-method">
      <h2 class="ir-h2"><span class="ir-num">02</span> How we measure</h2>
      <div class="ir-two">
        <div>
          <p class="ir-body">Every figure here comes directly from the Patient Navigator database, extracted on ${new Date(d.generated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. Counts are for the calendar month in IST unless marked otherwise.</p>
          <ul class="ir-defs">
            <li><b>Connected call</b> - a call logged with the outcome "connected". <b>Family reached</b> - a distinct patient household connected at least once in the month.</li>
            <li><b>Support delivered</b> - a support action marked done on a call (a resource shared, guidance given, a referral or assignment made). An output, not an outcome.</li>
            <li><b>Well-being outcome</b> - change between a patient's <i>first</i> and <i>latest</i> score on a validated instrument, counted only for patients assessed at least twice (paired pre/post).</li>
          </ul>
        </div>
        <div>
          <div class="ir-instr-title">Instruments</div>
          <table class="ir-instr">
            <tr><td>PHQ-4</td><td>Anxiety &amp; depression screen (lower is better)</td></tr>
            <tr><td>QoL</td><td>Quality of life, physical &amp; emotional (higher is better)</td></tr>
            <tr><td>MUST</td><td>Malnutrition risk (lower is better)</td></tr>
            <tr><td>Zarit-4</td><td>Caregiver burden (lower is better)</td></tr>
          </table>
          <div class="ir-caveat"><b>Limitations.</b> Well-being outcomes reflect only patients assessed twice; sample sizes (n=) are shown on every result and are still small for some measures. Financial aid is recorded as <i>guidance delivered</i>, not rupees disbursed, so it is reported as families guided.</div>
        </div>
      </div>
    </section>

    <!-- OUTCOMES / WELLBEING -->
    <section class="ir-section ir-page">
      <h2 class="ir-h2"><span class="ir-num">03</span> Measured outcomes: well-being change</h2>
      <p class="ir-sub">Share of re-assessed patients whose score moved in the healthy direction, first assessment to latest. Each bar shows its own sample size.</p>
      ${wbShown.length ? `<table class="ir-table">
        <thead><tr><th>Instrument</th><th class="ir-r">Re-assessed (n)</th><th class="ir-r">Improved</th><th class="ir-r">Improved %</th><th style="width:34%">Direction of change</th></tr></thead>
        <tbody>
        ${wbShown.map(w => { const p = pct(w.improved, w.reassessed); return `<tr>
          <td>${measureLabel(w.measure)}</td>
          <td class="ir-r ir-mono">${w.reassessed}</td>
          <td class="ir-r ir-mono">${w.improved}</td>
          <td class="ir-r ir-mono"><b>${p}%</b></td>
          <td><div class="ir-hbar-track" style="max-width:200px"><div class="ir-hbar-fill" style="width:${Math.max(3, p)}%;background:${A}"></div></div></td>
        </tr>`; }).join('')}
        </tbody></table>
        <p class="ir-src">Source: patient_assessments (paired first vs latest). n = patients with 2+ assessments on that instrument.</p>`
      : `<p class="ir-body">Not enough paired assessments yet this period to report well-being outcomes with a credible sample. Baselines are being captured; outcomes appear here once patients are re-assessed.</p>`}
    </section>

    <!-- MONTH ON MONTH -->
    <section class="ir-section">
      <h2 class="ir-h2"><span class="ir-num">04</span> Month on month</h2>
      <div class="ir-grid2">
        <div class="ir-chart"><div class="ir-chart-t">Calls placed and connected</div>${columns(trend.map(t => ({ label: t.label, v: t.calls })))}<div class="ir-chart-note">Connected: ${trend.map(t => t.connected).join(' · ')} · last 6 months</div></div>
        <div class="ir-chart"><div class="ir-chart-t">Families reached</div>${columns(trend.map(t => ({ label: t.label, v: t.reached })))}<div class="ir-chart-note">Distinct households connected each month</div></div>
        <div class="ir-chart"><div class="ir-chart-t">Support delivered</div>${columns(trend.map(t => ({ label: t.label, v: t.support })))}<div class="ir-chart-note">Support actions logged each month</div></div>
        <div class="ir-chart"><div class="ir-chart-t">Well-being check-ins</div>${columns(trend.map(t => ({ label: t.label, v: t.assessments })))}<div class="ir-chart-note">Assessments recorded each month</div></div>
      </div>
    </section>

    <!-- SUPPORT DELIVERED + REACH -->
    <section class="ir-section ir-page">
      <h2 class="ir-h2"><span class="ir-num">05</span> Support delivered &amp; reach</h2>
      <div class="ir-two">
        <div>
          <div class="ir-chart-t">What support was delivered (${period.label})</div>
          ${cov.length ? hbars(cov.slice(0, 8).map(c => ({ label: leverLabel(c.lever) || c.lever, v: c.n })), { accentFirst: true }) : `<p class="ir-body">No support logged this month.</p>`}
          <p class="ir-src">Source: patient_services marked done this month. n=${fmt(cov.reduce((a, c) => a + Number(c.n), 0))} actions.</p>
        </div>
        <div>
          <div class="ir-chart-t">Call outcomes (${period.label})</div>
          ${mix.length ? hbars(mix.map(m => ({ label: OUTCOME[m.status] || m.status, v: m.n, sub: `(${pct(m.n, totalMix)}%)` })), { accentFirst: true }) : ''}
          <p class="ir-src">Source: call_logs this month. n=${fmt(totalMix)} calls.</p>
        </div>
      </div>
    </section>

    <!-- COHORT -->
    <section class="ir-section">
      <h2 class="ir-h2"><span class="ir-num">06</span> Who we serve</h2>
      <div class="ir-cohort">
        <div class="ir-cohort-kpi"><div class="ir-kpi-num">${fmt(cohort.active)}</div><div class="ir-kpi-label">Families in active care</div></div>
        <div class="ir-cohort-kpi"><div class="ir-kpi-num">${cohort.consent_rate || 0}<span class="ir-kpi-unit">%</span></div><div class="ir-kpi-label">Consent on record</div></div>
        <div style="flex:1;min-width:240px">
          <div class="ir-chart-t">By cancer type (active cohort)</div>
          ${hbars((cohort.by_cancer || []).map(c => ({ label: c.key === 'unknown' ? 'Not yet recorded' : (giLabel(c.key) || c.key), v: c.n })), {})}
        </div>
      </div>
      <p class="ir-src">Snapshot of the current active cohort (not date-scoped).</p>
    </section>

    <!-- WHAT'S NEXT -->
    <section class="ir-section">
      <h2 class="ir-h2"><span class="ir-num">07</span> What we are watching</h2>
      <p class="ir-body">${nextNote(k, connRateCur, connRatePrev, wbShown)}</p>
    </section>

    <div class="ir-runfoot">Jarurat Care · Confidential · Data as of ${new Date(d.generated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
  </div>`;

  container.querySelector('#ir-pdf')?.addEventListener('click', () => {
    showToast('Opening print - choose "Save as PDF", and turn off browser headers/footers for a clean page.', 'info', 5000);
    setTimeout(() => window.print(), 350);
  });
  container.querySelector('#ir-month')?.addEventListener('change', (e) => { selectedMonth = e.target.value; renderReport(container); });
  container.querySelector('#ir-data')?.addEventListener('click', () => downloadReportData(d));
}

// Download the month's numbers as CSV sheets (month-on-month, well-being, support).
function downloadReportData(d) {
  const label = (d.period?.label || 'month').replace(/\s+/g, '_');
  const trend = (d.trend || []).map(t => ({ month: t.label, calls: t.calls, connected: t.connected, reached: t.reached,
    new_patients: t.new_patients, support: t.support, assessments: t.assessments, sessions: t.sessions, aid: t.aid }));
  exportToCSV(trend, `impact_${label}_month_on_month`, [
    { label: 'Month', key: 'month' }, { label: 'Calls placed', key: 'calls' }, { label: 'Connected', key: 'connected' },
    { label: 'Families reached', key: 'reached' }, { label: 'New families', key: 'new_patients' },
    { label: 'Support delivered', key: 'support' }, { label: 'Well-being check-ins', key: 'assessments' },
    { label: '1:1 sessions', key: 'sessions' }, { label: 'Aid recorded (INR)', key: 'aid' },
  ]);
  const wb = (d.wellbeing || []).map(w => ({ measure: measureLabel(w.measure), reassessed: w.reassessed, improved: w.improved,
    improved_pct: w.reassessed ? Math.round(w.improved / w.reassessed * 100) : 0, avg_delta: w.avg_delta }));
  if (wb.length) setTimeout(() => exportToCSV(wb, `impact_${label}_wellbeing_outcomes`, [
    { label: 'Instrument', key: 'measure' }, { label: 'Re-assessed (n)', key: 'reassessed' }, { label: 'Improved', key: 'improved' },
    { label: 'Improved %', key: 'improved_pct' }, { label: 'Avg change (healthy direction)', key: 'avg_delta' },
  ]), 450);
  const cov = (d.coverage || []).map(c => ({ support: leverLabel(c.lever) || c.lever, actions: c.n }));
  if (cov.length) setTimeout(() => exportToCSV(cov, `impact_${label}_support_delivered`, [
    { label: 'Support type', key: 'support' }, { label: 'Actions this month', key: 'actions' },
  ]), 900);
  showToast(`Downloading ${d.period?.label || ''} data as CSV sheets`, 'success');
}

function nextNote(k, cr, crPrev, wb) {
  const calls = Number(k.calls?.v), callsPrev = Number(k.calls?.prev);
  const bits = [];
  if (callsPrev && calls > callsPrev * 1.3) bits.push(`Call volume rose sharply this month (${fmt(calls)} vs ${fmt(callsPrev)}); we are watching whether connect quality holds as reach scales.`);
  if (cr < crPrev) bits.push(`Connect rate slipped to ${cr}% from ${crPrev}% - worth checking calling times and number quality.`);
  else if (cr >= crPrev && crPrev) bits.push(`Connect rate held at ${cr}%.`);
  const thin = wb.filter(w => w.reassessed < 15);
  if (thin.length) bits.push(`Several well-being measures still rest on small samples (n<15); the priority next month is completing follow-up assessments so outcomes are reportable with confidence.`);
  if (!bits.length) bits.push('Metrics are stable month on month. The focus next month is deepening follow-up assessment coverage so outcome samples grow.');
  return bits.join(' ');
}

// ---------- icons ----------
function heart() { return `<svg viewBox="0 0 24 24" fill="#fff" width="20" height="20"><path d="M12 21s-7.5-4.6-10-9.3C.6 8.4 2 5 5.5 5c2 0 3.4 1.1 4.5 2.4C11.1 6.1 12.5 5 14.5 5 18 5 19.4 8.4 22 11.7 19.5 16.4 12 21 12 21z"/></svg>`; }
function dlIcon() { return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`; }
function sheetIcon() { return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`; }

// ---------- styles (injected once) ----------
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
  .ir-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  .ir-bar-t{font-weight:660;font-size:19px;letter-spacing:-.02em;color:var(--ink)}
  .ir-bar-s{font:var(--t-xs);color:var(--ink-3);margin-top:2px}
  /* the document itself - warm-white sheet, dark ink, print-safe */
  .ir{--ink:#14201d;--ink2:#4b5754;--ink3:#7b8783;--line:${GRID};--a:${A};
     max-width:920px;margin:0 auto;background:#fff;color:var(--ink);
     font-family:'Archivo',system-ui,sans-serif;line-height:1.5;
     padding:34px 40px 60px;border:1px solid var(--line);border-radius:10px;box-shadow:0 1px 2px rgba(20,45,42,.05)}
  .ir *{box-sizing:border-box}
  .ir h1,.ir h2{font-family:'Archivo',system-ui,sans-serif}
  .ir-mono,.ir .ir-kpi-num,.ir-instr td:first-child{font-variant-numeric:tabular-nums}
  /* cover */
  .ir-cover{min-height:60vh;display:flex;flex-direction:column;justify-content:space-between;padding:8px 0 34px}
  .ir-cover-top{display:flex;align-items:center;gap:12px}
  .ir-mark{width:40px;height:40px;border-radius:11px;background:linear-gradient(160deg,#17ADB4,#0C6E74 60%,#08535A);display:grid;place-items:center;box-shadow:0 2px 6px rgba(4,32,31,.25)}
  .ir-mark-name{font-weight:740;font-size:16px;letter-spacing:.01em}
  .ir-mark-sub{font-family:'Spline Sans Mono',monospace;font-size:9px;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);margin-top:2px}
  .ir-cover-mid{margin:6vh 0}
  .ir-eyebrow{font-family:'Spline Sans Mono',monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--a);font-weight:600}
  .ir-cover-title{font-size:clamp(46px,8vw,76px);font-weight:720;letter-spacing:-.035em;line-height:1;margin:12px 0 10px}
  .ir-cover-range{font-size:15px;color:var(--ink2)}
  .ir-cover-foot{display:flex;flex-wrap:wrap;gap:6px 44px;font-size:12.5px;color:var(--ink2);border-top:2px solid var(--a);padding-top:16px}
  .ir-cover-foot .ir-lbl,.ir-lbl{font-family:'Spline Sans Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);display:block;margin-bottom:2px}
  .ir-conf{width:100%;color:var(--ink3);font-size:11.5px;margin-top:4px}
  /* sections */
  .ir-section{margin:30px 0}
  .ir-h2{font-size:20px;font-weight:640;letter-spacing:-.02em;display:flex;align-items:baseline;gap:12px;padding-bottom:9px;border-bottom:1px solid var(--line);margin-bottom:16px}
  .ir-num{font-family:'Spline Sans Mono',monospace;font-size:12px;color:var(--a);font-weight:600}
  .ir-lead{font-size:16px;line-height:1.62;color:var(--ink);max-width:70ch}
  .ir-lead b{font-weight:680;color:var(--ink)}
  .ir-body{font-size:13.5px;line-height:1.6;color:var(--ink2);max-width:68ch}
  .ir-sub{font-size:13px;color:var(--ink3);margin:-6px 0 14px;max-width:70ch}
  .ir-note{font-size:11.5px;color:var(--ink3);margin-top:12px;font-style:italic}
  .ir-src{font-family:'Spline Sans Mono',monospace;font-size:9.5px;color:var(--ink3);margin-top:8px}
  /* kpi grid */
  .ir-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .ir-kpi{background:#fff;padding:14px 15px 13px;break-inside:avoid}
  .ir-kpi-label{font-family:'Spline Sans Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3)}
  .ir-kpi-num{font-size:29px;font-weight:680;letter-spacing:-.02em;line-height:1.05;margin:5px 0 4px;font-variant-numeric:tabular-nums}
  .ir-kpi-unit{font-size:15px;font-weight:600;color:var(--ink2);margin-left:1px}
  .ir-kpi-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px}
  .ir-kpi-foot{font-size:10px;color:var(--ink3);margin-top:7px;line-height:1.35}
  .ir-delta{font-family:'Spline Sans Mono',monospace;font-size:10px;font-weight:600;white-space:nowrap}
  .ir-delta.ir-up{color:var(--a)} .ir-delta.ir-down{color:#9a6a2a} .ir-delta.ir-flat{color:var(--ink3)}
  .ir-delta-vs{color:var(--ink3);font-weight:400}
  .ir-kpi-spark{flex:none;opacity:.9}
  /* two-col + charts */
  .ir-two{display:grid;grid-template-columns:1fr 1fr;gap:26px}
  .ir-grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px}
  .ir-chart{break-inside:avoid}
  .ir-chart-t{font-weight:620;font-size:13px;margin-bottom:8px;letter-spacing:-.01em}
  .ir-chart-note{font-family:'Spline Sans Mono',monospace;font-size:9px;color:var(--ink3);margin-top:5px}
  .ir-defs{list-style:none;padding:0;margin:10px 0 0}
  .ir-defs li{font-size:12.5px;color:var(--ink2);padding:6px 0 6px 14px;border-left:2px solid var(--line);margin-bottom:6px;line-height:1.5}
  .ir-defs b{color:var(--ink)}
  .ir-instr-title,.ir-method .ir-instr-title{font-family:'Spline Sans Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);margin-bottom:6px}
  .ir-instr{width:100%;border-collapse:collapse;font-size:12px}
  .ir-instr td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  .ir-instr td:first-child{font-weight:700;color:var(--a);white-space:nowrap;width:64px}
  .ir-caveat{font-size:11.5px;color:var(--ink2);background:#F6F8F7;border:1px solid var(--line);border-radius:7px;padding:10px 12px;margin-top:12px;line-height:1.5}
  /* tables */
  .ir-table{width:100%;border-collapse:collapse;font-size:13px}
  .ir-table th{text-align:left;font-family:'Spline Sans Mono',monospace;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);padding:8px 10px;border-bottom:1.5px solid var(--ink);font-weight:600}
  .ir-table td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
  .ir-r{text-align:right}
  /* hbars */
  .ir-hbars{display:flex;flex-direction:column;gap:7px}
  .ir-hbar{display:grid;grid-template-columns:130px 1fr auto;align-items:center;gap:10px}
  .ir-hbar-l{font-size:12px;color:var(--ink2);text-align:right;line-height:1.2}
  .ir-hbar-track{height:9px;background:#EEF2F0;border-radius:5px;overflow:hidden}
  .ir-hbar-fill{height:100%;border-radius:5px}
  .ir-hbar-v{font-family:'Spline Sans Mono',monospace;font-size:12px;font-weight:600;white-space:nowrap}
  .ir-hbar-sub{color:var(--ink3);font-weight:400}
  /* cohort */
  .ir-cohort{display:flex;gap:26px;flex-wrap:wrap;align-items:flex-start}
  .ir-cohort-kpi{padding:2px 0}
  .ir-cohort-kpi .ir-kpi-num{font-size:34px}
  .ir-cohort-kpi .ir-kpi-label{margin-top:2px}
  /* running header/footer (screen: hidden; print: fixed) */
  .ir-runhead,.ir-runfoot{display:none}
  @media (max-width:760px){
    .ir{padding:20px 16px 40px}
    .ir-kpis{grid-template-columns:repeat(2,1fr)}
    .ir-two,.ir-grid2{grid-template-columns:1fr;gap:18px}
    .ir-hbar{grid-template-columns:96px 1fr auto}
  }
  /* ---------- PRINT ---------- */
  @media print{
    @page{size:A4;margin:15mm 14mm}
    body *{visibility:hidden !important}
    .ir,.ir *{visibility:visible !important}
    .ir{position:absolute;left:0;top:0;width:100%;max-width:none;margin:0;padding:0;border:0;box-shadow:none;border-radius:0}
    .ir-noprint,.conn-banner,#pwa-banner{display:none !important}
    .ir-page{break-after:page}
    .ir-section,.ir-kpi,.ir-chart,.ir-table,.ir-cover,tr{break-inside:avoid}
    .ir-h2{break-after:avoid}
    .ir-runhead{display:block;position:fixed;top:0;left:0;right:0;font-family:'Spline Sans Mono',monospace;font-size:8px;letter-spacing:.06em;color:#7b8783;padding-bottom:3px;border-bottom:1px solid #E3E9E7}
    .ir-runfoot{display:block;position:fixed;bottom:0;left:0;right:0;font-family:'Spline Sans Mono',monospace;font-size:8px;color:#7b8783;padding-top:3px;border-top:1px solid #E3E9E7}
    .ir-cover{padding-top:9mm;min-height:auto}
  }`;
  document.head.appendChild(s);
}
