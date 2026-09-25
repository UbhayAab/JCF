// ============================================================
// Patient Navigator: Data room, patient journeys
// The longitudinal half of the Data room, over the sql/138 views.
//
//   journeyDefs()          the download cards, one per journey view, plus
//                          the plain-English per-patient sheet
//   renderJourneysTab(el)  the Journeys tab: the cohort month by month since
//                          first contact, and one family's whole journey
//
// Every query goes through data_room_run, the same validated, de-identified
// door as the rest of the Data room, so the role gate and every definition
// (day 0, follow-up, a death, support) live in the database, not in here.
//
// data_room_run refuses whole words such as call, set, do and lock anywhere
// in the SQL text, string literals included. That is why the timeline says
// call_placed, and why no query below may use those words.
// ============================================================

import { getSupabase } from '../supabase.js';
import { createChart, CHART_COLORS, CHART_PALETTE } from '../utils/charts.js';
import { measureLabel, leverLabel, MEASURES, BEREAVEMENT_MEASURES } from '../utils/catalog.js';

const PAGE_ROWS = 50000;               // data_room_run's hard cap per call
const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-IN'));
const pct = (a, b) => (b ? (100 * a) / b : 0);
const p1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const monthLabel = (i) => `Month ${Number(i) + 1}`;
const alpha = (rgba, a) => rgba.replace(/[\d.]+\)$/, `${a})`);
const cell = (x) => (x === null || x === undefined ? '' : typeof x === 'boolean' ? String(x) : x);

async function run(sql, limit = PAGE_ROWS) {
  const { data, error } = await getSupabase().rpc('data_room_run', { p_sql: sql, p_limit: limit });
  if (error) throw new Error(error.message);
  if (!data || data.ok !== true) throw new Error(data?.reason || 'the Data room refused this query');
  return data;
}

// The timeline will outgrow one page. Page on a stable order until a short
// page comes back, so nobody silently gets the first 50,000 rows only.
async function runPaged(sql, order) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const page = await run(`${sql} order by ${order} limit ${PAGE_ROWS} offset ${offset}`);
    rows.push(...page.rows);
    if (page.row_count < PAGE_ROWS) return rows;
  }
}

// ============================================================
// Download cards
// ============================================================
const DATASETS = [
  { view: 'journeys', order: 'patient_code', perPatient: true, file: 'jcf_patient_journeys',
    name: 'Patient journeys, one row per patient (raw)',
    desc: 'The journeys view as the database has it: first contact (day 0), follow-up, calls, needs, support, concerns, sessions, first and latest wellbeing scores, and survival fields. Patients never reached are included with reached = false.' },
  { view: 'journey_months', order: 'patient_code, month_index', perPatient: true, file: 'jcf_journey_months',
    name: 'Journey months (the panel)',
    desc: 'One row per patient per month of follow-up: status at month end, calls, needs by kind, support, concerns, sessions and the latest wellbeing scores that month. The shape a longitudinal model wants.' },
  { view: 'timeline', order: 'patient_code, event_date, event_order', perPatient: true, file: 'jcf_journey_timeline',
    name: 'Journey timeline, every event',
    desc: 'Every call, need, support, reading, concern, session, status change and death, one row each, with days since first contact. Large: tens of thousands of rows.' },
  { view: 'readings', order: 'patient_code, measure, reading_seq', perPatient: true, file: 'jcf_wellbeing_readings_daily',
    name: 'Wellbeing readings, one per day',
    desc: 'Instrument scores collapsed to one per patient per measure per day, with the band the app shows mentors, the change from the first reading, and which way it moved.' },
  { view: 'status_history', order: 'patient_code, change_no', perPatient: true, file: 'jcf_status_history',
    name: 'Status history',
    desc: 'Every lifecycle change (new lead, active, inactive, deceased) the audit trail recorded, oldest first. The trail starts on 12 Jun 2026.' },
  { view: 'service_delivery', order: 'patient_code, recorded_on', perPatient: true, file: 'jcf_support_delivery',
    name: 'Support, with the day it was delivered',
    desc: 'Every support record with the day it was actually delivered and the need it answers. Outcome flags such as "treatment interrupted" are kept apart from support.' },
  { view: 'sessions', order: 'patient_code, created_on', perPatient: true, file: 'jcf_sessions_deidentified',
    name: '1:1 sessions (de-identified)',
    desc: 'Nutrition, wellbeing and caregiver sessions from invitation to held, without names or notes.' },
  { view: 'journey_curve', order: 'month_index', perPatient: false, file: 'jcf_journey_curve',
    name: 'The cohort, month by month since first contact',
    desc: 'How many patients were followed, reached, supported, assessed, went inactive or died in each month of the journey.' },
  { view: 'wellbeing_curve', order: 'measure, month_index', perPatient: false, file: 'jcf_wellbeing_curve',
    name: 'Wellbeing, month by month since first contact',
    desc: 'Mean and median score per instrument per month of the journey, the share above the action cut-off, and the change within each patient from their first reading.' },
  { view: 'cohort_months', order: 'month', perPatient: false, file: 'jcf_programme_by_month',
    name: 'The programme, calendar month by month',
    desc: 'Patients in follow-up, new, deaths, inactive, reached, calls and support per calendar month.' },
];

// The plain-English per-patient sheet. Same columns and order as PER_PATIENT
// in tools/build_longitudinal_pack.py; keep the two in step.
const PER_PATIENT = [
  ['patient_code', 'Patient code'], ['reached', 'Reached'], ['cohort_month', 'Joined (month of first contact)'],
  ['first_contact_date', 'First contact'], ['age', 'Age'], ['age_band', 'Age band'], ['gender', 'Gender'],
  ['state', 'State'], ['gi_subtype', 'Cancer type'], ['cancer_stage', 'Stage'], ['trajectory', 'Disease path'],
  ['economic_status', 'Economic status'], ['insurance_status', 'Insurance'], ['status_today', 'Status today'],
  ['follow_up_days', 'Days followed'], ['months_followed', 'Months followed'],
  ['death_date', 'Date of death'], ['death_date_source', 'Death date from'],
  ['died_before_first_contact', 'Reached after the patient had died'],
  ['days_first_contact_to_death', 'Days from first contact to death'],
  ['death_event', 'Survival: death (1) or alive (0)'], ['survival_days', 'Survival: days'],
  ['attempts_before_first_contact', 'Dial attempts before first contact'],
  ['days_first_attempt_to_contact', 'Days from first attempt to first contact'],
  ['calls_placed', 'Calls placed'], ['calls_connected', 'Calls connected'], ['talk_minutes', 'Talk minutes'],
  ['months_with_contact', 'Months with a connected call'], ['last_connected_on', 'Last connected call'],
  ['needs_raised', 'Needs raised'], ['needs_by_mentor', 'Needs from call form'], ['needs_by_nlp', 'Needs from notes reader'],
  ['need_categories', 'Kinds of need'], ['first_need_on', 'First need'], ['days_to_first_need', 'Days to first need'],
  ['support_delivered', 'Support delivered'], ['support_kinds', 'Kinds of support'],
  ['first_support_on', 'First support'], ['days_to_first_support', 'Days to first support'],
  ['support_still_planned', 'Support still planned'], ['financial_aid_inr', 'Financial aid (INR)'],
  ['main_request_resolved', 'Main request resolved'], ['treatment_interrupted', 'Treatment interrupted'],
  ['concerns_raised', 'Concerns escalated'], ['concerns_resolved', 'Concerns resolved'],
  ['sessions_offered', 'Sessions offered'], ['sessions_held', 'Sessions held'],
  ['readings', 'Wellbeing readings'], ['instruments_measured', 'Instruments measured'],
  ['mentors_distinct', 'Different mentors'], ['mentor_assignments', 'Mentor assignments'],
];
const KEY_MEASURES = ['phq4_patient', 'phq4_caregiver', 'qol_physical', 'qol_emotional', 'financial_toxicity',
  'must_malnutrition', 'zarit_burden', 'activation', 'caregiver_confidence'];
const MONTHLY = [['status_at_month_end', 'status'], ['calls_connected', 'calls connected'],
  ['needs_raised', 'needs raised'], ['support_delivered', 'support delivered']];

function perPatientColumns(months) {
  const cols = PER_PATIENT.map(([key, label]) => ({ label, accessor: (r) => cell(r[key]) }));
  KEY_MEASURES.forEach((m) => {
    const name = measureLabel(m);
    const first = (r) => r[`${m}_first`];
    const latest = (r) => r[`${m}_latest`];
    cols.push({ label: `${name}: first`, accessor: (r) => cell(first(r)) });
    cols.push({ label: `${name}: latest`, accessor: (r) => cell(latest(r)) });
    cols.push({ label: `${name}: change`, accessor: (r) => (first(r) === null || latest(r) === null
      ? '' : Math.round((latest(r) - first(r)) * 100) / 100) });
  });
  MONTHLY.forEach(([key, label]) => months.forEach((i) => cols.push({
    label: `${monthLabel(i)}: ${label}`, accessor: (r) => cell(r.months?.[i]?.[key]) })));
  return cols;
}

async function buildPerPatient() {
  const [journeys, months] = await Promise.all([
    runPaged('select * from journeys', 'patient_code'),
    runPaged('select patient_code, month_index, status_at_month_end, calls_connected, needs_raised, support_delivered from journey_months',
      'patient_code, month_index'),
  ]);
  const byCode = {};
  months.forEach((m) => { (byCode[m.patient_code] ||= {})[m.month_index] = m; });
  const idx = [...new Set(months.map((m) => m.month_index))].sort((a, b) => a - b);
  const rows = journeys.map((j) => ({ ...j, status_today: j.deceased ? 'died' : j.current_status,
    months: byCode[j.patient_code] || {} }));
  return { rows, columns: perPatientColumns(idx) };
}

function datasetCard(d) {
  return {
    key: 'journey_' + d.view, research: true, journey: true, ico: d.perPatient ? 'activity' : 'chart', pid: null,
    code: d.perPatient ? (r) => r.patient_code : null,
    name: d.name, desc: d.desc, file: d.file, countFrom: null,
    build: async () => {
      const rows = await runPaged(`select * from ${d.view}`, d.order);
      const columns = rows.length ? Object.keys(rows[0]).map((k) => ({ label: k, accessor: (r) => cell(r[k]) })) : [];
      return { rows, columns };
    },
  };
}

export function journeyDefs() {
  return [{
    key: 'journey_per_patient', research: true, journey: true, ico: 'users', pid: null,
    code: (r) => r.patient_code,
    name: 'Per patient, the whole journey (plain English)',
    desc: 'START HERE. One row per patient: first contact, follow-up, calls, needs, support, concerns, survival, first and latest score on each wellbeing instrument, and each month side by side (status, calls connected, needs, support). Patient codes only.',
    file: 'jcf_per_patient_journeys', countFrom: null, build: buildPerPatient,
  }, ...DATASETS.map(datasetCard)];
}

// ============================================================
// The Journeys tab
// ============================================================
const SQL = {
  kpis: `select count(*) as registry, count(*) filter (where reached) as reached,
      percentile_cont(0.5) within group (order by follow_up_days) filter (where reached) as median_follow_up_days,
      sum(calls_connected) as calls_connected, round(sum(talk_minutes) / 60.0) as talk_hours,
      count(*) filter (where support_delivered > 0) as supported, sum(support_delivered) as support_delivered,
      count(*) filter (where death_event = 1) as deaths, count(*) filter (where died_before_first_contact) as died_before,
      count(*) filter (where reached and not deceased and current_status = 'active') as active_now,
      count(*) filter (where reached and not deceased and current_status = 'inactive') as inactive_now,
      count(*) filter (where reached and deceased) as deceased_now,
      sum(concerns_raised) as concerns_raised, sum(concerns_resolved) as concerns_resolved,
      (select count(distinct x.patient_code) from (
         select r.patient_code from readings r join journeys j2 on j2.patient_code = r.patient_code
         where r.recorded_on between j2.first_contact_date and j2.follow_up_end
         group by r.patient_code, r.measure having count(*) >= 2) x) as measured_twice
    from journeys`,
  curve: 'select * from journey_curve order by month_index',
  reach: `select m.month_index, count(*) as followed, count(*) filter (where m.reached) as reached,
      count(*) filter (where j.cohort_month >= '2026-07') as followed_jul,
      count(*) filter (where m.reached and j.cohort_month >= '2026-07') as reached_jul
    from journey_months m join journeys j on j.patient_code = m.patient_code
    group by m.month_index order by m.month_index`,
  needs: `select month_index, sum(need_financial) as financial, sum(need_nutrition) as nutrition,
      sum(need_housing) as housing, sum(need_emotional) as emotional,
      sum(need_caregiver + need_documents + need_clinical_info + need_medicines + need_other) as other
    from journey_months group by month_index order by month_index`,
  change: `with r as (
      select r.patient_code, r.measure, r.higher_is_worse, r.recorded_on, r.score
      from readings r join journeys j on j.patient_code = r.patient_code
      where r.recorded_on between j.first_contact_date and j.follow_up_end),
    f as (
      select measure, patient_code, bool_and(higher_is_worse) as hw,
             (array_agg(score order by recorded_on))[1] as fs, (array_agg(score order by recorded_on desc))[1] as ls
      from r group by measure, patient_code having count(*) >= 2)
    select measure, bool_and(hw) as higher_is_worse, count(*) as patients,
      round(avg(fs), 2) as mean_first, round(avg(ls), 2) as mean_latest,
      count(*) filter (where (hw and ls < fs) or (not hw and ls > fs)) as better,
      count(*) filter (where ls = fs) as unchanged,
      count(*) filter (where (hw and ls > fs) or (not hw and ls < fs)) as worse
    from f group by measure having count(*) >= 10 order by measure`,
  survival: 'select survival_days, death_event from journeys where death_event is not null',
  codes: 'select patient_code from journeys where reached order by patient_code',
};

const note = (text) => `<p style="font:var(--t-xs);color:var(--ink-3);margin:0">${text}</p>`;
const panel = (id, title, sub, height = 280) => `
  <div class="card" style="display:flex;flex-direction:column;gap:8px;min-width:0">
    <strong style="font:var(--t-body-strong)">${title}</strong>
    <span style="font:var(--t-xs);color:var(--ink-3)">${sub}</span>
    <div style="position:relative;height:${height}px"><canvas id="${id}"></canvas></div>
  </div>`;

function shellHtml() {
  const grid = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:var(--s4);margin-bottom:var(--s4)';
  return `
    <div class="card" style="margin-bottom:var(--s4);display:grid;gap:6px">
      <strong style="font:var(--t-body-strong)">Patient journeys</strong>
      ${note('Day 0 is the day a mentor first reached the family. Follow-up runs to the patient\'s death or today. Month 1 is the month of first contact. Patient codes only: open one family below to see their whole journey on one line.')}
      <span id="jr-status">${note('Reading the journeys…')}</span>
    </div>
    <div id="jr-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:var(--s3);margin-bottom:var(--s4)"></div>
    <div style="${grid}">
      ${panel('jr-status-chart', 'Where patients are at the end of each month', 'Share of the patients followed that month.')}
      ${panel('jr-rhythm', 'What happens for patients each month', 'Share of the patients followed that month.')}
    </div>
    <div style="${grid}">
      ${panel('jr-reach', 'Reached by phone at least once that month', 'July onwards is the fair series: calls were barely logged before July.')}
      ${panel('jr-needs', 'Needs raised, by kind', 'Share of all needs raised that month, both channels.')}
    </div>
    <div style="${grid}">
      ${panel('jr-change', 'Wellbeing: first reading against latest, per patient', 'Patients measured at least twice on the instrument during follow-up.', 320)}
      ${panel('jr-surv', 'Alive, by days since first contact', 'Kaplan-Meier. The living count only up to their last connected call.', 320)}
    </div>
    <div class="card" style="display:grid;gap:10px">
      <strong style="font:var(--t-body-strong)">One family's journey</strong>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <input id="jr-code" class="form-input" list="jr-codes" placeholder="Patient code" autocomplete="off" style="max-width:220px">
        <datalist id="jr-codes"></datalist>
        <button class="btn btn-primary btn-sm" id="jr-go">Show journey</button>
        <button class="btn btn-ghost btn-sm" id="jr-random">Any family</button>
      </div>
      <div id="jr-family">${note('Pick a patient code to see every call, need, support, reading, concern and status change on one timeline.')}</div>
    </div>`;
}

export async function renderJourneysTab(host) {
  host.innerHTML = shellHtml();
  try {
    const [kpi, curve, reach, needs, change, surv, codes] = await Promise.all(
      ['kpis', 'curve', 'reach', 'needs', 'change', 'survival', 'codes'].map((k) => run(SQL[k])));
    const k = kpi.rows[0];
    host.querySelector('#jr-status').innerHTML = note(`Live from the database. ${fmt(k.reached)} of ${fmt(k.registry)} patients reached.`);
    renderKpis(host.querySelector('#jr-kpis'), k);
    drawStatus(curve.rows, k.died_before);
    drawRhythm(curve.rows);
    drawReach(reach.rows);
    drawNeeds(needs.rows);
    drawChange(change.rows);
    drawSurvival(surv.rows);
    bindPicker(host, codes.rows.map((r) => r.patient_code));
  } catch (e) {
    host.querySelector('#jr-status').innerHTML = note('The journeys could not be loaded: ' + esc(e.message));
  }
}

function renderKpis(el, k) {
  const tiles = [
    [fmt(k.reached), `patients reached, of ${fmt(k.registry)}`],
    [`${Math.round(k.median_follow_up_days)} days`, 'median follow-up'],
    [fmt(k.calls_connected), `conversations, ${fmt(k.talk_hours)} hours`],
    [`${Math.round(pct(k.supported, k.reached))}%`, `received support (${fmt(k.support_delivered)} acts)`],
    [fmt(k.measured_twice), 'wellbeing measured twice or more'],
    [fmt(k.deaths), `deaths in follow-up (${fmt(k.died_before)} reached after death)`],
  ];
  el.innerHTML = tiles.map(([b, s]) => `
    <div class="card" style="display:grid;gap:2px;padding:14px 16px">
      <strong class="tnum" style="font-size:24px;line-height:1.15">${b}</strong>
      <span style="font:var(--t-xs);color:var(--ink-3)">${s}</span>
    </div>`).join('');
}

// Shared chart options on top of createChart's themed defaults.
function opts(extra = {}) {
  return { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: true, position: 'bottom' } }, ...extra };
}
const pctScale = (max = 100, stacked = false) => ({ min: 0, max, stacked, ticks: { callback: (v) => `${v}%` } });
const legendBottom = { display: true, position: 'bottom' };

function drawStatus(curve, diedBefore) {
  const n = curve.map((r) => r.patients_followed);
  const series = [
    ['Active', CHART_COLORS.primary, curve.map((r) => r.active_at_month_end)],
    ['Inactive', CHART_COLORS.warning, curve.map((r) => r.inactive_at_month_end)],
    ['Patient died this month', CHART_COLORS.slate, curve.map((r) => r.died_this_month)],
    ['Reached after the patient had died', alpha(CHART_COLORS.slate, 0.35), curve.map((r, i) => (i === 0 ? diedBefore : 0))],
  ];
  createChart('jr-status-chart', 'bar', {
    labels: curve.map((r) => [monthLabel(r.month_index), `n = ${fmt(r.patients_followed)}`]),
    datasets: series.map(([label, color, raw]) => ({ label, raw, data: raw.map((x, i) => pct(x, n[i])), backgroundColor: color,
      borderRadius: 3, borderSkipped: false, maxBarThickness: 56 })),
  }, opts({ scales: { x: { stacked: true }, y: pctScale(100, true) },
    plugins: { legend: legendBottom, tooltip: { callbacks: {
      label: (c) => ` ${c.dataset.label}: ${fmt(c.dataset.raw[c.dataIndex])} (${p1(c.parsed.y)}%)` } } } }));
}

function drawRhythm(curve) {
  const lines = [['Raised a need', CHART_COLORS.primary, 'patients_with_need'], ['Received support', CHART_COLORS.success, 'patients_supported'],
    ['Wellbeing measured', CHART_COLORS.info, 'patients_assessed'], ['Concern escalated', CHART_COLORS.rose, 'patients_with_concern']];
  createChart('jr-rhythm', 'line', {
    labels: curve.map((r) => monthLabel(r.month_index)),
    datasets: lines.map(([label, color, key]) => ({ label, data: curve.map((r) => pct(r[key], r.patients_followed)),
      borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 3, tension: 0 })),
  }, opts({ scales: { y: pctScale(60) }, plugins: { legend: legendBottom,
    tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${p1(c.parsed.y)}%` } } } }));
}

function drawReach(rows) {
  const jul = rows.map((r) => (r.followed_jul ? pct(r.reached_jul, r.followed_jul) : null));
  createChart('jr-reach', 'line', {
    labels: rows.map((r) => monthLabel(r.month_index)),
    datasets: [
      { label: 'Joined July onwards', data: jul, borderColor: CHART_COLORS.primary, backgroundColor: CHART_COLORS.primary,
        borderWidth: 2, pointRadius: 4, spanGaps: false },
      { label: 'All joiners', data: rows.map((r) => pct(r.reached, r.followed)), borderColor: CHART_COLORS.slate,
        backgroundColor: CHART_COLORS.slate, borderWidth: 2, pointRadius: 3 },
    ],
  }, opts({ scales: { y: pctScale(100) }, plugins: { legend: legendBottom,
    tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y === null ? 'not yet' : p1(c.parsed.y) + '%'}` } } } }));
}

function drawNeeds(rows) {
  const keys = [['Financial', 'financial', CHART_COLORS.primary], ['Nutrition', 'nutrition', CHART_COLORS.warning],
    ['Housing', 'housing', CHART_COLORS.info], ['Emotional', 'emotional', CHART_PALETTE[2]], ['Other', 'other', CHART_COLORS.slate]];
  const tot = rows.map((r) => keys.reduce((a, [, k]) => a + Number(r[k] || 0), 0));
  createChart('jr-needs', 'bar', {
    labels: rows.map((r, i) => [monthLabel(r.month_index), `${fmt(tot[i])} needs`]),
    datasets: keys.map(([label, k, color]) => ({ label, raw: rows.map((r) => r[k]), data: rows.map((r, i) => pct(r[k], tot[i])),
      backgroundColor: color, borderRadius: 3, borderSkipped: false, maxBarThickness: 56 })),
  }, opts({ scales: { x: { stacked: true }, y: pctScale(100, true) }, plugins: { legend: legendBottom,
    tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.dataset.raw[c.dataIndex])} (${p1(c.parsed.y)}%)` } } } }));
}

function drawChange(rows) {
  const order = (m) => (KEY_MEASURES.indexOf(m) + 1 || 99);
  const r = [...rows].sort((a, b) => order(a.measure) - order(b.measure));
  const share = (x, key) => pct(x[key], x.patients);
  createChart('jr-change', 'bar', {
    labels: r.map((x) => `${measureLabel(x.measure)} (n ${x.patients})`),
    datasets: [['Better', 'better', CHART_COLORS.success], ['No change', 'unchanged', alpha(CHART_COLORS.slate, 0.35)], ['Worse', 'worse', CHART_COLORS.rose]]
      .map(([label, key, color]) => ({ label, data: r.map((x) => share(x, key)), backgroundColor: color,
        borderRadius: 3, borderSkipped: false, maxBarThickness: 18 })),
  }, opts({ indexAxis: 'y', interaction: { mode: 'nearest', axis: 'y', intersect: false },
    scales: { x: pctScale(100, true), y: { stacked: true, ticks: { autoSkip: false } } },
    plugins: { legend: legendBottom, tooltip: { callbacks: {
      label: (c) => ` ${c.dataset.label}: ${p1(c.parsed.x)}%`,
      afterBody: (items) => {
        const x = r[items[0].dataIndex];
        return `Mean ${x.mean_first} to ${x.mean_latest}${x.higher_is_worse ? ' (lower is better)' : ''}`;
      } } } } }));
}

function kaplanMeier(rows) {
  const t = rows.map((r) => ({ d: Number(r.survival_days), e: Number(r.death_event) }));
  const days = [...new Set(t.filter((x) => x.e === 1).map((x) => x.d))].sort((a, b) => a - b);
  let s = 1;
  const pts = [{ x: 0, y: 100 }];
  days.forEach((d) => {
    const atRisk = t.filter((x) => x.d >= d).length;
    s *= 1 - t.filter((x) => x.d === d && x.e === 1).length / atRisk;
    pts.push({ x: d, y: 100 * s });
  });
  return pts;
}

function drawSurvival(rows) {
  const cut = 120;
  const pts = kaplanMeier(rows).filter((p) => p.x <= cut);
  pts.push({ x: cut, y: pts[pts.length - 1].y });
  createChart('jr-surv', 'line', {
    datasets: [{ label: 'Alive', data: pts, stepped: 'before', borderColor: CHART_COLORS.primary, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4 }],
  }, opts({ interaction: { mode: 'nearest', axis: 'x', intersect: false },
    scales: { x: { type: 'linear', min: 0, max: cut, ticks: { stepSize: 30, callback: (v) => (v === cut ? `${v} days` : v) } },
      y: { ...pctScale(100), min: 50 } },
    plugins: { legend: { display: false }, tooltip: { callbacks: {
      title: (i) => `Day ${i[0].parsed.x}`, label: (c) => ` Alive: ${p1(c.parsed.y)}%` } } } }));
}

// ============================================================
// One family's journey
// ============================================================
const LANES = ['Calls', 'Needs', 'Support', 'Wellbeing', 'Concerns', 'Sessions', 'Status'];
// look -> [lane, legend label, color, point style, filled]
const LOOK = {
  first_contact: [0, 'First contact', CHART_COLORS.primary, 'rectRot', true],
  call_connected: [0, 'Call, connected', CHART_COLORS.primary, 'circle', true],
  call_missed: [0, 'Call, not connected', CHART_COLORS.slate, 'circle', false],
  need_raised: [1, 'Need raised', CHART_COLORS.warning, 'triangle', true],
  support_delivered: [2, 'Support delivered', CHART_COLORS.success, 'rect', true],
  support_offered: [2, 'Support offered or planned', CHART_COLORS.info, 'rect', false],
  resources_sent: [2, 'Resources sent on WhatsApp', CHART_COLORS.info, 'rect', true],
  outcome_recorded: [2, 'Outcome recorded', CHART_COLORS.slate, 'rect', false],
  wellbeing_reading: [3, 'Wellbeing reading', CHART_COLORS.accent, 'circle', true],
  concern_raised: [4, 'Concern escalated', CHART_COLORS.rose, 'crossRot', true],
  concern_resolved: [4, 'Concern resolved', CHART_COLORS.success, 'crossRot', true],
  red_flag: [4, 'Red flag in the notes', CHART_COLORS.rose, 'triangle', false],
  session_held: [5, 'Session held', CHART_COLORS.success, 'star', true],
  session_other: [5, 'Session offered or missed', CHART_COLORS.slate, 'star', false],
  status_changed: [6, 'Status changed', CHART_COLORS.slate, 'rectRounded', true],
  death: [6, 'Death', CHART_COLORS.danger, 'crossRot', true],
};

function lookOf(ev) {
  const t = ev.event_type;
  if (t === 'call_placed') return ev.code === 'connected' ? 'call_connected' : 'call_missed';
  if (t === 'support_planned') return 'support_offered';
  if (t === 'session_offered' || t === 'session_missed') return 'session_other';
  if (t === 'nlp_signal') return String(ev.code).startsWith('red_flag') ? 'red_flag' : null;
  return LOOK[t] ? t : null;
}

const EVENT_LABEL = {
  first_contact: 'First contact', call_placed: 'Call', need_raised: 'Need raised', nlp_signal: 'Signal in the notes',
  support_offered: 'Support offered', support_planned: 'Support planned', support_delivered: 'Support delivered',
  outcome_recorded: 'Outcome recorded', wellbeing_reading: 'Wellbeing reading', concern_raised: 'Concern escalated',
  concern_resolved: 'Concern resolved', session_offered: 'Session offered', session_held: 'Session held',
  session_missed: 'Session missed', status_changed: 'Status changed', death: 'Death', resources_sent: 'Resources sent on WhatsApp',
};

function describe(ev) {
  const t = ev.event_type;
  const lever = ['support_offered', 'support_planned', 'support_delivered', 'outcome_recorded'].includes(t);
  const code = lever ? leverLabel(ev.code) : t === 'wellbeing_reading' ? measureLabel(ev.code) : (ev.code || '');
  const value = t === 'wellbeing_reading' ? `score ${ev.value}`
    : t === 'call_placed' && ev.value ? `${ev.value} min`
      : t === 'concern_resolved' ? `after ${ev.value} days` : (ev.value ?? '');
  return [code, value, ev.detail || ''].filter((x) => x !== '' && x !== null).map(String);
}

function bindPicker(host, codes) {
  const input = host.querySelector('#jr-code');
  host.querySelector('#jr-codes').innerHTML = codes.map((c) => `<option value="${esc(c)}">`).join('');
  const go = () => showFamily(host, input.value.trim());
  host.querySelector('#jr-go').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  host.querySelector('#jr-random').addEventListener('click', () => {
    input.value = codes[Math.floor(Math.random() * codes.length)] || '';
    go();
  });
}

async function showFamily(host, code) {
  const out = host.querySelector('#jr-family');
  if (!CODE_RE.test(code)) { out.innerHTML = note('Enter a patient code from the list.'); return; }
  out.innerHTML = note('Reading this journey…');
  try {
    const [j, t] = await Promise.all([
      run(`select * from journeys where patient_code = '${code}'`),
      run(`select * from timeline where patient_code = '${code}' order by event_date, event_order`)]);
    if (!j.rows.length) { out.innerHTML = note(`No patient has the code ${esc(code)}.`); return; }
    const events = t.rows.filter((e) => e.event_type !== 'mentor_assigned');
    out.innerHTML = familyHtml(j.rows[0], events, t.rows.length - events.length);
    drawFamily(events);
    drawFamilyReadings(out, events);
  } catch (e) {
    out.innerHTML = note('This journey could not be loaded: ' + esc(e.message));
  }
}

function familyHtml(j, events, mentorRows) {
  const chip = (label, value) => (value === null || value === undefined || value === ''
    ? '' : `<span class="badge badge-neutral" style="white-space:normal">${esc(label)}: ${esc(value)}</span>`);
  const status = j.deceased ? `died${j.death_date ? ' ' + String(j.death_date).slice(0, 10) : ''}` : j.current_status;
  const rows = events.map((e) => `<tr><td>${esc(String(e.event_date).slice(0, 10))}</td>
    <td class="tnum">${esc(e.days_since_first_contact ?? '')}</td>
    <td>${esc(EVENT_LABEL[e.event_type] || e.event_type)}</td><td>${describe(e).map(esc).join(' · ')}</td></tr>`).join('');
  return `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${chip('Code', j.patient_code)}${chip('Status', status)}${chip('First contact', String(j.first_contact_date || '').slice(0, 10))}
      ${chip('Days followed', j.follow_up_days)}${chip('Cancer', j.gi_subtype)}${chip('Stage', j.cancer_stage)}${chip('Age band', j.age_band)}
      ${chip('State', j.state)}${chip('Calls connected', j.calls_connected)}${chip('Needs', j.needs_raised)}
      ${chip('Support delivered', j.support_delivered)}${chip('Concerns', j.concerns_raised)}${chip('Mentor changes', mentorRows)}
    </div>
    <div style="position:relative;height:300px"><canvas id="jr-one"></canvas></div>
    <div id="jr-one-readings" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--s3);margin-top:var(--s3)"></div>
    <details style="margin-top:var(--s3)"><summary style="cursor:pointer;font:var(--t-xs);color:var(--ink-2)">Every event, in order (${events.length})</summary>
      <div style="overflow-x:auto;margin-top:8px"><table class="table" style="width:100%;font:var(--t-xs)">
        <thead><tr><th>Date</th><th>Day</th><th>Event</th><th>What</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
}

function drawFamily(events) {
  const groups = {};
  events.forEach((e) => {
    const look = lookOf(e);
    if (!look || e.days_since_first_contact === null) return;
    (groups[look] ||= []).push({ x: Number(e.days_since_first_contact), y: LOOK[look][0], ev: e });
  });
  const xs = events.map((e) => Number(e.days_since_first_contact)).filter((x) => Number.isFinite(x));
  createChart('jr-one', 'scatter', {
    datasets: Object.entries(groups).map(([look, data]) => {
      const [, label, color, style, filled] = LOOK[look];
      return { label, data, pointStyle: style, pointRadius: look === 'death' || look === 'first_contact' ? 9 : 6,
        pointHoverRadius: 9, borderColor: color, backgroundColor: filled ? color : 'transparent', borderWidth: 2 };
    }),
  }, opts({ interaction: { mode: 'nearest', intersect: true },
    scales: {
      x: { type: 'linear', min: Math.min(0, ...xs) - 2, max: Math.max(10, ...xs) + 2,
        title: { display: true, text: 'Days since first contact' } },
      // Left to itself Chart.js puts the ticks on the half-steps between
      // lanes, where no label exists, and the axis comes out blank.
      y: { type: 'linear', min: -0.5, max: LANES.length - 0.5, reverse: true, beginAtZero: false,
        afterBuildTicks: (axis) => { axis.ticks = LANES.map((_, i) => ({ value: i })); },
        grid: { display: false }, ticks: { autoSkip: false, callback: (v) => LANES[v] ?? '' } },
    },
    plugins: { legend: legendBottom, tooltip: { callbacks: {
      title: (items) => { const e = items[0].raw.ev; return `${String(e.event_date).slice(0, 10)} (day ${e.days_since_first_contact})`; },
      label: (c) => ` ${EVENT_LABEL[c.raw.ev.event_type] || c.raw.ev.event_type}: ${describe(c.raw.ev).join(' · ')}` } } } }));
}

// One small chart per instrument measured at least twice, on the app's own
// scale for that instrument, so a move from 3 to 6 on PHQ-4 reads as large.
function drawFamilyReadings(out, events) {
  const scales = Object.fromEntries([...MEASURES, ...BEREAVEMENT_MEASURES].map((m) => [m.key, m]));
  const by = {};
  events.filter((e) => e.event_type === 'wellbeing_reading').forEach((e) => (by[e.code] ||= []).push(e));
  const host = out.querySelector('#jr-one-readings');
  const series = Object.entries(by).filter(([, list]) => list.length >= 2);
  host.innerHTML = series.length ? series.map(([m], i) => `
    <div style="border:1px solid var(--line);border-radius:8px;padding:8px">
      <span style="font:var(--t-xs);color:var(--ink-2)">${esc(measureLabel(m))}${scales[m]?.dir < 0 ? ' (lower is better)' : ''}</span>
      <div style="position:relative;height:110px"><canvas id="jr-one-r${i}"></canvas></div>
    </div>`).join('') : note('No instrument was measured twice for this family.');
  series.forEach(([m, list], i) => {
    const sc = scales[m] || {};
    createChart(`jr-one-r${i}`, 'line', {
      datasets: [{ label: measureLabel(m), data: list.map((e) => ({ x: Number(e.days_since_first_contact), y: Number(e.value) })),
        borderColor: CHART_COLORS.accent, backgroundColor: CHART_COLORS.accent, borderWidth: 2, pointRadius: 3 }],
    }, opts({ plugins: { legend: { display: false } }, interaction: { mode: 'nearest', intersect: false },
      scales: { x: { type: 'linear', ticks: { maxTicksLimit: 4 } },
        y: { min: sc.min ?? undefined, max: sc.max ?? undefined, ticks: { maxTicksLimit: 4 } } } }));
  });
}
