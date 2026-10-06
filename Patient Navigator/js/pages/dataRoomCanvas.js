// ============================================================
// Patient Navigator: Data room, the patient canvas
//
// Priyanka, 6 Oct 2026: "One Patient -> One longitudinal profile ->
// Multiple reports/documents -> Time-stamped & structured -> Chronological
// treatment journey." Pick a family and every report, scan, biopsy, blood test
// and chemotherapy cycle sits on one time axis, with the family's calls,
// needs, support and concerns on the same line; a "what changed" box worked
// out from the papers; trends for the blood tests a doctor follows; and the
// whole record one click away as an Excel workbook, a CSV or a printed page.
//
//   renderCanvasTab(host, { code })   the tab; a code opens one family directly
//
// What it reads lives in dataRoomCanvasData.js and what it writes in
// dataRoomCanvasExport.js. sql/158 explains every derived column.
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin } from '../auth.js';
import { navigate } from '../router.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { createChart, CHART_COLORS } from '../utils/charts.js';
import { valueLabel } from '../components/analyticsFilters.js';
import {
  CODE_RE, LANES, esc, num, day, dayMs, fmtDay, fmtVal, valueText, todayIST, cancerLabel, plural, groupRank, rangeText,
  spanText, papersText,
  loadFamily, loadRoster, whatChanged, journeyLook, reportShort, reportTone, laneLabel,
} from './dataRoomCanvasData.js';
import { downloadFamilyWorkbook, downloadFamilyTimelineCSV, openFamilyPrint, downloadCohortWorkbook } from './dataRoomCanvasExport.js';
import { injectCanvasStyles } from './dataRoomCanvasStyles.js';

// The blood tests a trend is drawn for, in the order an oncologist reads them.
const TREND_TESTS = ['haemoglobin', 'wbc', 'anc', 'platelets', 'creatinine', 'urea', 'bilirubin_total', 'alt', 'ast',
  'alp', 'albumin', 'sodium', 'potassium', 'cea', 'ca19_9', 'ca125', 'crp'];
const PX_PER_DAY = 4;       // a year is about 1,460 px before the track scrolls sideways
const MAX_TRACK = 8000;
const PAD = 28;             // keeps the first and last marker clear of the edges
const CLUSTER_PX = 34;      // markers closer than this merge into one that shows how many
const DAY_MS = 864e5;
const TONE_RANK = { plain: 0, info: 1, good: 2, warn: 3, bad: 4 };
const OUT_OF_RANGE = ['low', 'high', 'abnormal'];

let S = { roster: null, fam: null, clusters: [], req: 0, width: 0 };

const labelWidth = () => (window.matchMedia('(max-width: 600px)').matches ? 104 : 148);

// ============================================================
// The tab
// ============================================================
export function renderCanvasTab(host, { code } = {}) {
  injectCanvasStyles();
  S = { roster: null, fam: null, clusters: [], req: 0, width: 0, host };
  host.innerHTML = `<div class="pc"><div id="pc-pick">${pickerHtml()}</div><div id="pc-fam" hidden></div></div>`;
  bindPicker(host);
  loadRoster()
    .then((r) => { if (host.isConnected) { S.roster = r; renderRoster(host); } })
    .catch((e) => setStatus(host, 'The families could not be read: ' + e.message));
  const asked = String(code || '').trim().toUpperCase();
  if (asked && CODE_RE.test(asked)) openFamily(host, asked);
  watchWidth(host);
}

function setStatus(host, text) {
  const el = host.querySelector('#pc-status');
  if (el) el.textContent = text;
}

// Keeps the address bar on the family being read, so the page can be
// bookmarked, sent to a colleague or reloaded. replaceState fires no
// hashchange, so the router does not draw the Data room again.
// The address also rides on the tab's own element, so exports.js can put it
// back when the tab is shown again without importing anything new from here
// (a new import of a new export is what tools/stale_import_check.mjs guards).
function setHash(code) {
  const url = `#exports?tab=canvas${code ? '&code=' + encodeURIComponent(code) : ''}`;
  if (S.host) S.host.dataset.hash = url;
  if (window.location.hash !== url) { try { history.replaceState(null, '', url); } catch { /* file:// */ } }
}

async function withBusy(btn, work) {
  if (btn.disabled) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
  try {
    await work((text) => { btn.textContent = text; });
  } catch (e) {
    showToast(e.message || 'That did not work. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

// ============================================================
// The picker
// ============================================================
function pickerHtml() {
  return `
  <div class="card pc-intro">
    <div class="pc-row-between">
      <div class="pc-intro-text">
        <h2 class="pc-h">Patient canvas</h2>
        <p class="pc-note">One family's whole medical record on one screen: every report in date order with what it says, the values read off it, the chemotherapy cycles, and their journey with JCF on the same line. Download any family as one Excel file. Patient codes only.</p>
      </div>
      <button class="btn btn-ghost btn-sm" id="pc-every" type="button" title="Every family's medical record, every table, as one Excel workbook">${icon('download')}Every family (Excel)</button>
    </div>
    <form class="pc-search" id="pc-search" autocomplete="off">
      <label class="pc-sr" for="pc-code">Patient code</label>
      <input id="pc-code" class="form-input" list="pc-codes" placeholder="Patient code, for example PAT-2026-01041" spellcheck="false" maxlength="40">
      <datalist id="pc-codes"></datalist>
      <button class="btn btn-primary btn-sm" type="submit">${icon('arrowRight')}Open the canvas</button>
    </form>
    <p class="pc-note" id="pc-status" role="status">Reading the families with medical papers…</p>
  </div>
  <div class="card">
    <div class="pc-list-head">
      <h3 class="pc-h">Families with medical papers</h3>
      <span class="pc-note" id="pc-count"></span>
      <span class="pc-grow"></span>
      <label class="pc-sr" for="pc-filter">Filter the families</label>
      <input id="pc-filter" class="form-input pc-filter" placeholder="Filter by code or cancer" spellcheck="false">
      <label class="pc-sr" for="pc-sort">Order the families</label>
      <select id="pc-sort" class="form-select pc-sort">
        <option value="recent">Latest upload first</option>
        <option value="most">Most reports first</option>
        <option value="code">By patient code</option>
      </select>
    </div>
    <div class="pc-tablewrap"><table class="pc-table" id="pc-list">
      <thead><tr><th>Patient</th><th>Cancer</th><th>Reports</th><th>Dates covered</th><th>Last upload</th><th>Scans</th><th>Lab values</th><th>Cycles</th><th>Phase today</th></tr></thead>
      <tbody><tr><td colspan="9"><div class="pc-loading"><div class="spinner" aria-hidden="true"></div><span class="pc-note">Loading…</span></div></td></tr></tbody>
    </table></div>
  </div>`;
}

function bindPicker(host) {
  host.querySelector('#pc-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = host.querySelector('#pc-code').value.trim().toUpperCase();
    if (!CODE_RE.test(code)) { setStatus(host, 'Type a patient code, for example PAT-2026-01041.'); return; }
    openFamily(host, code);
  });
  host.querySelector('#pc-filter').addEventListener('input', () => { if (S.roster) drawList(host); });
  host.querySelector('#pc-sort').addEventListener('change', () => { if (S.roster) drawList(host); });
  host.querySelector('#pc-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-open]');
    if (row) openFamily(host, row.dataset.open);
  });
  const every = host.querySelector('#pc-every');
  every.addEventListener('click', () => withBusy(every, async (say) => {
    const n = await downloadCohortWorkbook((i, of, name) => say(`${i} of ${of}: ${name}…`));
    showToast(`Every family's record downloaded: ${plural(n.families, 'family', 'families')}, ${plural(n.reports, 'report')}`, 'success');
  }));
}

function renderRoster(host) {
  const { withPapers, codes } = S.roster;
  host.querySelector('#pc-codes').innerHTML = codes.map((c) => `<option value="${esc(c)}">`).join('');
  setStatus(host, `${plural(withPapers.length, 'family has', 'families have')} medical papers on file. Any of the ${codes.length.toLocaleString('en-IN')} patient codes opens a canvas, with or without papers.`);
  drawList(host);
}

function drawList(host) {
  const q = host.querySelector('#pc-filter').value.trim().toLowerCase();
  const order = {
    recent: (a, b) => day(b.last_upload_on).localeCompare(day(a.last_upload_on)),
    most: (a, b) => num(b.reports) - num(a.reports),
    code: (a, b) => a.patient_code.localeCompare(b.patient_code),
  }[host.querySelector('#pc-sort').value];
  const all = S.roster.withPapers;
  const rows = all.filter((r) => !q || r.patient_code.toLowerCase().includes(q) || cancerLabel(r).toLowerCase().includes(q)).sort(order);
  host.querySelector('#pc-count').textContent = q ? `${rows.length} of ${all.length}` : `${all.length}`;
  host.querySelector('#pc-list tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr class="pc-row" data-open="${esc(r.patient_code)}">
      <td><button type="button" class="pc-linkbtn pc-nowrap" data-open="${esc(r.patient_code)}">${esc(r.patient_code)}</button></td>
      <td>${esc(cancerLabel(r))}</td>
      <td class="tnum">${esc(r.reports)}${num(r.reports_dated) < num(r.reports) ? `<span class="pc-note"> (${esc(r.reports_dated)} dated)</span>` : ''}</td>
      <td>${r.first_report_on ? esc(spanText(r.first_report_on, r.last_report_on)) : '<span class="pc-note">no dates on the reports</span>'}</td>
      <td>${esc(fmtDay(r.last_upload_on))}</td>
      <td class="tnum">${esc(r.scans)}</td>
      <td class="tnum">${esc(r.lab_values)}${num(r.lab_values_outside_range) ? `<span class="pc-note"> (${esc(r.lab_values_outside_range)} outside the range)</span>` : ''}</td>
      <td class="tnum">${esc(r.cycles_recorded)}</td>
      <td>${esc(r.care_phase_today)}</td>
    </tr>`).join('') : `<tr><td colspan="9" class="pc-note">No family matches "${esc(q)}".</td></tr>`;
}

function showPicker(host) {
  S.req++;
  S.fam = null;
  const fam = host.querySelector('#pc-fam');
  fam.hidden = true;
  fam.innerHTML = '';
  host.querySelector('#pc-pick').hidden = false;
  setHash('');
}

// ============================================================
// One family
// ============================================================
async function openFamily(host, code) {
  const req = ++S.req;
  const famEl = host.querySelector('#pc-fam');
  host.querySelector('#pc-pick').hidden = true;
  famEl.hidden = false;
  famEl.innerHTML = `<div class="card pc-loading"><div class="spinner" aria-hidden="true"></div><p class="pc-note" role="status">Reading the record of ${esc(code)}…</p></div>`;
  setHash(code);
  try {
    const fam = await loadFamily(code);
    // The reader may have gone back, opened another family or left the page.
    if (req !== S.req || !host.isConnected) return;
    if (!fam.patient) {
      famEl.innerHTML = `<div class="card pc-fam"><p class="pc-note">No patient has the code ${esc(code)}.</p>${backButton()}</div>`;
      bindBack(host);
      return;
    }
    S.fam = fam;
    famEl.innerHTML = familyHtml(fam);
    bindFamily(host, fam);
    drawCanvas(host, fam);
    drawTrends(host, fam);
    drawReports(host, fam, '');
    window.scrollTo?.({ top: Math.max(0, famEl.getBoundingClientRect().top + window.scrollY - 90), behavior: 'smooth' });
  } catch (e) {
    if (req !== S.req || !host.isConnected) return;
    famEl.innerHTML = `<div class="card pc-fam"><p class="pc-note">This record could not be read: ${esc(e.message)}</p>${backButton()}</div>`;
    bindBack(host);
  }
}

const backButton = () => `<div><button class="btn btn-ghost btn-sm" id="pc-back" type="button">${icon('arrowLeft')}All families</button></div>`;

function bindBack(host) {
  host.querySelector('#pc-back')?.addEventListener('click', () => showPicker(host));
}

function familyHtml(fam) {
  const s = fam.summary || {};
  const p = fam.patient || {};
  const stage = p.cancer_stage && p.cancer_stage !== 'unknown' ? valueLabel('stage', p.cancer_stage) : '';
  const bits = [cancerLabel(s.gi_subtype || s.cancer_type ? s : p), stage,
    s.diagnosed_on ? `diagnosed ${fmtDay(s.diagnosed_on)}` : 'diagnosis date not on file',
    num(s.reports) ? `${plural(s.reports, 'report')}${s.first_report_on ? `, ${spanText(s.first_report_on, s.last_report_on)}` : ''}`
      : 'no medical papers on file yet'];
  const phase = s.care_phase_today || 'Phase not known';
  return `
  <div class="pc-fam">
    ${backButton()}
    <div class="card pc-head">
      <div class="pc-head-main">
        <div class="pc-title"><h2 class="pc-code">${esc(fam.code)}</h2>
          <span class="badge ${phase === 'During treatment' ? 'badge-info' : 'badge-neutral'}">${esc(phase)}</span></div>
        <p class="pc-sub">${bits.filter(Boolean).map(esc).join(' · ')}</p>
      </div>
      <div class="pc-actions">
        <button class="btn btn-primary btn-sm" id="pc-xlsx" type="button" title="Every table for this family as one Excel workbook">${icon('download')}Download this family</button>
        <button class="btn btn-ghost btn-sm" id="pc-csv" type="button" title="The timeline below as one CSV">Timeline CSV</button>
        <button class="btn btn-ghost btn-sm" id="pc-print" type="button" title="A clean page to print, or save as PDF from the print dialog">Print or PDF</button>
        ${isManagerOrAdmin() ? `<button class="btn btn-ghost btn-sm" id="pc-record" type="button" title="The family's record, with names and the original papers">${icon('fileText')}Open the record</button>` : ''}
      </div>
    </div>
    <div class="pc-cols">
      <section class="card" aria-labelledby="pc-changed-h"><h3 class="pc-h" id="pc-changed-h">What changed</h3>${changedHtml(fam)}</section>
      <section class="card" aria-labelledby="pc-facts-h"><h3 class="pc-h" id="pc-facts-h">The record in short</h3>${factsHtml(fam)}</section>
    </div>
    <section class="card" aria-labelledby="pc-tl-h">
      <div class="pc-row-between"><h3 class="pc-h" id="pc-tl-h">Timeline</h3>${legendHtml()}</div>
      <p class="pc-note pc-gap">Every dated report and event on one line. Tap a marker to see what the report says; markers a few days apart merge and show how many. Shading is the phase of care as the papers show it:
        <i class="pc-key pc-key-dx" aria-hidden="true"></i> at diagnosis, <i class="pc-key pc-key-tx" aria-hidden="true"></i> during treatment.</p>
      <div class="pc-tl"><div class="pc-tl-labels" id="pc-tl-labels"></div><div class="pc-scroll" id="pc-scroll"></div></div>
      <div id="pc-undated"></div>
    </section>
    <section class="card pc-detail" id="pc-detail" hidden aria-live="polite"></section>
    <section class="card" id="pc-trends-card" hidden aria-labelledby="pc-tr-h">
      <h3 class="pc-h" id="pc-tr-h">Blood tests and weight over time</h3>
      <p class="pc-note pc-gap">Every tracked test the family had more than once. Red points are outside the range; the dashed lines are the range printed on the latest report.</p>
      <div class="pc-trends" id="pc-trends"></div>
    </section>
    <section class="card" aria-labelledby="pc-rep-h">
      <div class="pc-row-between"><h3 class="pc-h" id="pc-rep-h">Every report, in date order</h3><div class="pc-chips" id="pc-groups"></div></div>
      <div class="pc-tablewrap pc-gap"><table class="pc-table" id="pc-reports"></table></div>
    </section>
  </div>`;
}

function changedHtml(fam) {
  const list = whatChanged(fam);
  if (!list.length) {
    return '<p class="pc-note pc-gap">Nothing on the papers says anything changed. One report, or reports with nothing to compare, look like this.</p>';
  }
  return `<ul class="pc-changes">${list.map((w) => `<li class="t-${esc(w.tone)}"><span class="pc-dot" aria-hidden="true"></span><span>${esc(w.text)}</span></li>`).join('')}</ul>`;
}

function factsHtml(fam) {
  const s = fam.summary || {};
  const p = fam.patient || {};
  const count = (type, pred = () => true) => fam.events.filter((e) => e.event_type === type && pred(e)).length;
  const met = fam.events.find((e) => e.event_type === 'first_contact')?.event_date || s.first_contact_date || p.first_contact_date;
  const facts = [
    ['Diagnosis', [cancerLabel(s.gi_subtype || s.cancer_type ? s : p), s.primary_site || p.primary_site, s.histology || p.histology].filter(Boolean).join(', ')],
    ['Diagnosed', s.diagnosed_on ? `${fmtDay(s.diagnosed_on)}, from the ${s.diagnosed_on_basis}` : ''],
    ['Pathology', [s.first_pathology_diagnosis, s.differentiation].filter(Boolean).join('; ')],
    ['Markers', s.biomarker_results],
    ['Treatment', [s.regimens, num(s.cycles_recorded) ? `${plural(s.cycles_recorded, 'cycle')} on paper, the last on ${fmtDay(s.last_cycle_on)}` : ''].filter(Boolean).join('. ')],
    ['Latest scan', s.last_scan ? `${s.last_scan}, ${fmtDay(s.last_scan_on)}${s.last_scan_change_noted ? `: ${s.last_scan_change_noted}` : ''}` : ''],
    ['Latest blood test', s.last_test_on ? `${fmtDay(s.last_test_on)}: ${s.last_test_outside_range || 'the tracked tests were within the range'}` : ''],
    ['Weight', num(s.latest_weight_kg) !== null
      ? `${fmtVal(s.latest_weight_kg)} kg on ${fmtDay(s.latest_weight_on)}${num(s.weight_change_pct) ? ` (${num(s.weight_change_pct) > 0 ? '+' : ''}${s.weight_change_pct}% since the first on file)` : ''}` : ''],
    ['Papers on file', papersText(s) || 'None yet'],
    ['Hospitals', s.hospitals],
    ['With JCF', [met ? `since ${fmtDay(met)}` : '', plural(count('call_placed', (e) => e.code === 'connected'), 'call connected', 'calls connected'),
      plural(count('need_raised'), 'need'), plural(count('support_delivered'), 'act of support', 'acts of support'),
      plural(count('concern_raised'), 'concern')].filter(Boolean).join(', ')],
  ];
  return `<dl class="pc-dl">${facts.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

function legendHtml() {
  const key = (tone, text) => `<span><i class="pc-key t-${tone}" aria-hidden="true"></i>${text}</span>`;
  return `<div class="pc-legend">${key('bad', 'A scan says it grew')}${key('warn', 'Outside the range, or late')}
    ${key('good', 'Shrank, back in range, or help given')}${key('info', 'Diagnosis, markers, cycles')}${key('plain', 'On file')}</div>`;
}

function bindFamily(host, fam) {
  bindBack(host);
  const xl = host.querySelector('#pc-xlsx');
  xl.addEventListener('click', () => withBusy(xl, async () => {
    await downloadFamilyWorkbook(fam);
    showToast(`${fam.code}: the whole record downloaded as one workbook`, 'success');
  }));
  host.querySelector('#pc-csv').addEventListener('click', () => {
    const n = downloadFamilyTimelineCSV(fam);
    showToast(n ? `${fam.code}: timeline downloaded, ${plural(n, 'row')}` : 'Nothing on the timeline yet', n ? 'success' : 'info');
  });
  host.querySelector('#pc-print').addEventListener('click', () => {
    if (!openFamilyPrint(fam)) showToast('Pop-ups are blocked, so the page was downloaded instead. Open it and print.', 'info');
  });
  const rec = host.querySelector('#pc-record');
  rec?.addEventListener('click', () => withBusy(rec, async () => {
    const { data, error } = await getSupabase().from('patients').select('id').eq('patient_code', fam.code).maybeSingle();
    if (error || !data) throw new Error('This family\'s record could not be found');
    navigate('patients/' + data.id);
  }));
  host.querySelector('#pc-scroll').addEventListener('click', (e) => {
    const mk = e.target.closest('.pc-mk');
    if (!mk) return;
    host.querySelectorAll('.pc-mk.is-sel').forEach((m) => m.classList.remove('is-sel'));
    mk.classList.add('is-sel');
    showDetail(host, S.clusters[Number(mk.dataset.c)]?.items || [], mk);
  });
  const openReport = (e) => {
    const el = e.target.closest('[data-report]');
    if (!el) return;
    const r = fam.reports.find((x) => x.report_ref === el.dataset.report);
    if (r) showDetail(host, [{ kind: 'report', ref: r.report_ref, date: r.report_date }], el);
  };
  host.querySelector('#pc-undated').addEventListener('click', openReport);
  host.querySelector('#pc-reports').addEventListener('click', openReport);
  host.querySelector('#pc-groups').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-group]');
    if (chip) drawReports(host, fam, chip.dataset.group);
  });
}

// ============================================================
// The timeline
// ============================================================
function canvasItems(fam) {
  const items = [];
  const add = (date, it) => { if (dayMs(date) !== null) items.push({ t: dayMs(date), date: day(date), ...it }); };
  fam.reports.forEach((r) => add(r.report_date, { lane: r.report_group, short: reportShort(r), tone: reportTone(r),
    label: `${r.report_type_label}${r.hospital ? `, ${r.hospital}` : ''}`, kind: 'report', ref: r.report_ref }));
  fam.cycles.forEach((c) => add(c.administered_on, { lane: 'Treatment', short: c.cycle_no !== null && c.cycle_no !== undefined ? `C${c.cycle_no}` : 'C',
    tone: num(c.days_later_than_planned) > 7 ? 'warn' : 'info', label: `Cycle ${c.cycle_no ?? ''} of ${c.regimen_name || 'treatment'}`, kind: 'cycle', row: c }));
  fam.body.forEach((b) => { if (num(b.weight_kg) !== null) add(b.measured_on, { lane: 'Weight', short: `${Math.round(num(b.weight_kg))} kg`,
    tone: num(b.weight_change_from_first_pct) <= -5 ? 'warn' : 'plain', label: `Weight ${fmtVal(b.weight_kg)} kg`, kind: 'weight', row: b }); });
  fam.events.forEach((e) => { const j = journeyLook(e); if (j) add(e.event_date, { lane: j.lane, short: j.short, tone: j.tone, label: j.label, kind: 'journey', row: e }); });
  return items;
}

// Greedy left to right: a marker joins the cluster on its left when it sits
// within CLUSTER_PX of that cluster's first marker.
function clusterLane(list) {
  const out = [];
  [...list].sort((a, b) => a.x - b.x).forEach((it) => {
    const c = out[out.length - 1];
    if (c && it.x - c.x0 < CLUSTER_PX) { c.items.push(it); c.x = c.items.reduce((a, b) => a + b.x, 0) / c.items.length; }
    else out.push({ x0: it.x, x: it.x, items: [it] });
  });
  return out;
}

function ticks(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  const span = (hi - lo) / DAY_MS;
  const fmt = (t, o) => new Date(t).toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });
  const out = [];
  if (span < 50) {
    for (let t = lo; t <= hi; t += 7 * DAY_MS) out.push({ at: t, label: fmt(t, { day: 'numeric', month: 'short' }) });
    return out;
  }
  const step = span > 1460 ? 12 : span > 540 ? 3 : 1;
  const d = new Date(lo);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  while (m % step !== 0) m++;
  // "Oct 2026", never "Oct 26", which reads as a day. Bounded: 400 ticks is
  // 33 years of months, far past any record.
  for (let guard = 0; guard < 400; guard++) {
    y += Math.floor(m / 12); m %= 12;
    const t = Date.UTC(y, m, 1);
    if (t > hi) break;
    out.push({ at: t, label: step >= 12 ? String(y) : fmt(t, { month: 'short', year: 'numeric' }) });
    m += step;
  }
  return out;
}

function drawCanvas(host, fam) {
  const s = fam.summary || {};
  const scroll = host.querySelector('#pc-scroll');
  const undated = fam.reports.filter((r) => !r.report_date);
  host.querySelector('#pc-undated').innerHTML = undated.length ? `
    <div class="pc-undated"><span class="pc-note">${plural(undated.length, 'report')} with no date on ${undated.length === 1 ? 'it' : 'them'}:</span>
      ${undated.map((r) => `<button type="button" class="pc-chip" data-report="${esc(r.report_ref)}">${esc(r.report_type_label)}<span class="pc-chip-note">uploaded ${esc(fmtDay(r.uploaded_on))}</span></button>`).join('')}
    </div>` : '';
  const items = canvasItems(fam);
  const labels = host.querySelector('#pc-tl-labels');
  S.clusters = [];
  if (!items.length) {
    labels.hidden = true;
    scroll.innerHTML = '<p class="pc-note pc-empty">Nothing dated on file yet.</p>';
    S.width = scroll.clientWidth;
    return;
  }

  // The lane names sit in a column of their own beside the scrolling track:
  // a sticky cell inside a grid cannot leave its cell, so it scrolled away.
  const lanes = LANES.filter((l) => items.some((i) => i.lane === l.key));
  labels.hidden = false;
  labels.style.width = `${labelWidth()}px`;
  labels.innerHTML = `<div class="pc-lab pc-axis-lab">Date</div>${lanes.map((l) => `<div class="pc-lab">${esc(l.label)}</div>`).join('')}`;
  S.width = scroll.clientWidth;

  let lo = Math.min(...items.map((i) => i.t));
  let hi = Math.max(...items.map((i) => i.t));
  const today = dayMs(todayIST());
  if (today >= hi && today - hi <= 120 * DAY_MS) hi = today;   // a recent record shows where today is
  if (hi - lo < 30 * DAY_MS) { const mid = (lo + hi) / 2; lo = mid - 15 * DAY_MS; hi = mid + 15 * DAY_MS; }
  const avail = Math.max(220, scroll.clientWidth);
  const trackW = Math.min(MAX_TRACK, Math.max(avail, Math.round(((hi - lo) / DAY_MS) * PX_PER_DAY)));
  const x = (ms) => Math.round(PAD + ((ms - lo) / (hi - lo)) * (trackW - 2 * PAD));

  const byLane = Object.fromEntries(lanes.map((l) => [l.key, clusterLane(items.filter((i) => i.lane === l.key).map((i) => ({ ...i, x: x(i.t) })))]));

  const tx = dayMs(s.first_treatment_on);
  const dx = dayMs(s.diagnosed_on);
  const bands = [];
  if (tx !== null) {
    if (tx > lo) bands.push({ cls: 'dx', label: 'At diagnosis', a: lo, b: Math.min(tx, hi) });
    if (tx < hi) bands.push({ cls: 'tx', label: 'During treatment', a: Math.max(tx, lo), b: hi });
  } else if (dx !== null && dx + 60 * DAY_MS > lo && dx < hi) {
    bands.push({ cls: 'dx', label: 'At diagnosis', a: Math.max(lo, dx), b: Math.min(hi, dx + 60 * DAY_MS) });
  }
  const met = dayMs(fam.events.find((e) => e.event_type === 'first_contact')?.event_date || s.first_contact_date);
  const lines = [[dx, 'Diagnosed'], [met, 'Met JCF'], [today, 'Today']]
    .filter(([at]) => at !== null && at >= lo && at <= hi).map(([at, label]) => ({ at, label }));
  const tk = ticks(lo, hi);

  const marker = (c) => {
    const idx = S.clusters.push(c) - 1;
    const n = c.items.length;
    const tone = c.items.reduce((t, i) => (TONE_RANK[i.tone] > TONE_RANK[t] ? i.tone : t), 'plain');
    const days = [...new Set(c.items.map((i) => i.date))].sort();
    const when = days.length > 1 ? `${fmtDay(days[0])} to ${fmtDay(days[days.length - 1])}` : fmtDay(days[0]);
    const what = n === 1 ? c.items[0].label : `${n} items: ${c.items.slice(0, 3).map((i) => i.label).join('; ')}${n > 3 ? '; and more' : ''}`;
    const text = n > 1 ? String(n) : c.items[0].short;
    return `<button type="button" class="pc-mk t-${tone}${text ? '' : ' is-dot'}" style="left:${Math.round(c.x)}px" data-c="${idx}"
      aria-label="${esc(`${what}, ${when}`)}" title="${esc(`${what}, ${when}`)}">${esc(text)}</button>`;
  };

  scroll.innerHTML = `
    <div class="pc-track" style="width:${trackW}px">
      <div class="pc-bands" aria-hidden="true">
        ${bands.map((b) => `<div class="pc-band ${b.cls}" style="left:${x(b.a)}px;width:${Math.max(2, x(b.b) - x(b.a))}px"><span>${esc(b.label)}</span></div>`).join('')}
        ${tk.map((t) => `<div class="pc-gridline" style="left:${x(t.at)}px"></div>`).join('')}
        ${lines.map((l) => `<div class="pc-line" style="left:${x(l.at)}px"></div>`).join('')}
      </div>
      <div class="pc-axis">
        ${tk.map((t) => `<span class="pc-tick" style="left:${x(t.at)}px">${esc(t.label)}</span>`).join('')}
        ${lines.map((l) => `<span class="pc-tag" style="left:${x(l.at)}px">${esc(l.label)}</span>`).join('')}
      </div>
      ${lanes.map((l) => `<div class="pc-lane" role="group" aria-label="${esc(l.label)}">${byLane[l.key].map(marker).join('')}</div>`).join('')}
    </div>`;
  // Open on the latest papers: the scroll starts at the right-hand end.
  scroll.scrollLeft = scroll.scrollWidth;
}

// A phone turned sideways, or a window made wider, redraws the track to fit.
function watchWidth(host) {
  let timer = null;
  const onResize = () => {
    if (!host.isConnected) { window.removeEventListener('resize', onResize); return; }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const scroll = host.querySelector('#pc-scroll');
      if (S.fam && scroll && Math.abs(scroll.clientWidth - S.width) > 60) drawCanvas(host, S.fam);
    }, 250);
  };
  window.addEventListener('resize', onResize);
}

// ============================================================
// What a marker opens
// ============================================================
const tag = (t, cls = '') => (t === '' || t === null || t === undefined ? '' : `<span class="pc-tagchip ${esc(cls)}">${esc(t)}</span>`);
const flagBadge = (f) => (OUT_OF_RANGE.includes(f) ? ` <span class="badge badge-warn">${esc(f)}</span>` : '');

function showDetail(host, items, from) {
  const panel = host.querySelector('#pc-detail');
  if (!panel || !S.fam) return;
  const dates = [...new Set(items.map((i) => day(i.date)).filter(Boolean))].sort();
  const title = dates.length > 1 ? `${fmtDay(dates[0])} to ${fmtDay(dates[dates.length - 1])}` : dates.length ? fmtDay(dates[0]) : 'No date on the report';
  panel.hidden = false;
  panel.innerHTML = `
    <div class="pc-row-between"><h3 class="pc-h">${esc(title)}</h3>
      <button type="button" class="btn btn-ghost btn-sm" id="pc-detail-close">Close</button></div>
    ${items.map((it) => itemHtml(S.fam, it)).join('')}
    ${items.some((it) => it.kind === 'journey') ? '<p class="pc-note">Calls, needs, support and concerns come from the JCF record of calls and care, not from the papers.</p>' : ''}`;
  panel.querySelector('#pc-detail-close').addEventListener('click', () => {
    panel.hidden = true;
    host.querySelectorAll('.pc-mk.is-sel').forEach((m) => m.classList.remove('is-sel'));
    from?.focus?.();
  });
  panel.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

function itemHtml(fam, it) {
  if (it.kind === 'report') {
    const r = fam.reports.find((x) => x.report_ref === it.ref);
    return r ? reportHtml(fam, r) : '';
  }
  if (it.kind === 'cycle') return cycleHtml(it.row);
  if (it.kind === 'weight') return weightHtml(it.row);
  return `<article class="pc-item pc-item-j"><header><strong>${esc(it.label)}</strong><span class="pc-note">${esc(fmtDay(it.date))}</span></header></article>`;
}

function reportHtml(fam, r) {
  const mine = (list) => list.filter((x) => x.report_ref === r.report_ref);
  const scans = mine(fam.scans), paths = mine(fam.pathology), marks = mine(fam.biomarkers), labs = mine(fam.labs);
  const cycles = mine(fam.cycles), drugs = mine(fam.medicines).filter((m) => !m.is_supportive);
  const tags = [
    tag(r.care_phase), r.cycle_no ? tag(`after cycle ${r.cycle_no}${r.regimen_at_the_time ? ` of ${r.regimen_at_the_time}` : ''}`) : '',
    tag(r.hospital), tag(r.source), tag(`uploaded ${fmtDay(r.uploaded_on)}`), r.pages ? tag(plural(r.pages, 'page')) : '',
    r.repeat_of_earlier ? tag(`repeats ${r.repeats_report || 'an earlier report'}: ${r.repeat_basis}`, 'is-warn') : '', tag(r.report_ref),
  ].join('');
  const finding = !scans.length && !paths.length && r.key_finding ? `<p class="pc-finding">${esc(r.key_finding)}</p>` : '';
  const nothing = !finding && !scans.length && !paths.length && !marks.length && !labs.length && !cycles.length && !drugs.length;
  return `<article class="pc-item">
    <header><strong>${esc(r.report_type_label)}</strong><span class="pc-note">${r.report_date ? esc(fmtDay(r.report_date)) : 'No date on the report'}</span></header>
    <div class="pc-tags">${tags}</div>
    ${finding}
    ${scans.map(scanHtml).join('')}${paths.map(pathHtml).join('')}
    ${marks.length ? markersHtml(marks) : ''}${labs.length ? labsHtml(labs) : ''}
    ${cycles.length || drugs.length ? treatmentHtml(cycles, drugs) : ''}
    ${nothing ? '<p class="pc-note">Nothing was read off this report beyond its type and date. The original is on the family\'s record.</p>' : ''}
  </article>`;
}

function scanHtml(x) {
  const tone = !x.change_noted ? '' : x.change_noted.startsWith('growth') ? 'badge-danger' : x.change_noted.startsWith('shrink') ? 'badge-ok' : 'badge-neutral';
  return `<div class="pc-block">
    <div class="pc-block-h">${esc(x.modality)}${x.study_description ? `<span class="pc-note">${esc(x.study_description)}</span>` : ''}${x.change_noted ? `<span class="badge ${tone}">${esc(x.change_noted)}</span>` : ''}</div>
    ${x.impression ? `<p class="pc-pre">${esc(x.impression)}</p>` : ''}
    ${x.lesion_list ? `<p class="pc-note"><strong>Each lesion:</strong> ${esc(x.lesion_list)}</p>` : ''}
    ${x.indication ? `<p class="pc-note">Why it was done: ${esc(x.indication)}</p>` : ''}
  </div>`;
}

function pathHtml(x) {
  return `<div class="pc-block">
    <div class="pc-block-h">${esc(String(x.report_kind || 'Pathology').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))}${x.specimen ? `<span class="pc-note">${esc(x.specimen)}</span>` : ''}</div>
    ${x.diagnosis ? `<p class="pc-finding">${esc(x.diagnosis)}</p>` : ''}
    ${x.differentiation ? `<p class="pc-note">Differentiation: ${esc(x.differentiation)}</p>` : ''}
    ${x.impression && x.impression !== x.diagnosis ? `<p class="pc-pre">${esc(x.impression)}</p>` : ''}
    ${x.laboratory ? `<p class="pc-note">${esc(x.laboratory)}</p>` : ''}
  </div>`;
}

function markersHtml(list) {
  return `<div class="pc-block"><div class="pc-block-h">Markers</div>
    <div class="pc-tablewrap"><table class="pc-table"><thead><tr><th>Marker</th><th>Result</th><th>Score</th><th>Interpretation</th></tr></thead>
    <tbody>${list.map((m) => `<tr><td>${esc(m.marker)}</td><td>${esc(m.result || '')}</td><td>${esc(m.score || '')}</td><td>${esc(m.interpretation || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function sinceHtml(l) {
  if (num(l.previous_value) === null) return '<span class="pc-note">first reading</span>';
  const arrow = l.direction === 'up' ? '↑' : l.direction === 'down' ? '↓' : '=';
  const moved = l.range_change ? ` <span class="badge ${l.range_change === 'back in range' ? 'badge-ok' : 'badge-warn'}">${esc(l.range_change)}</span>` : '';
  return `${arrow} from ${esc(fmtVal(l.previous_value))} on ${esc(fmtDay(l.previous_on))}${moved}`;
}

function labsHtml(labs) {
  const rows = labs.filter((l) => !l.read_again_from_another_copy)
    .sort((a, b) => groupRank(a.test_group) - groupRank(b.test_group) || String(a.test).localeCompare(String(b.test)));
  const again = labs.length - rows.length;
  return `<div class="pc-block"><div class="pc-block-h">Values read off this report</div>
    <div class="pc-tablewrap"><table class="pc-table"><thead><tr><th>Test</th><th>Value</th><th>Range</th><th>Since the last reading</th></tr></thead>
    <tbody>${rows.map((l) => `<tr><td>${esc(l.test)}<div class="pc-note">${esc(l.test_group)}</div></td>
      <td class="tnum">${esc(valueText(l))}${flagBadge(l.flag)}</td><td class="pc-note">${esc(rangeText(l))}</td><td>${sinceHtml(l)}</td></tr>`).join('')}</tbody></table></div>
    ${again ? `<p class="pc-note">${plural(again, 'value')} on this copy ${again === 1 ? 'was' : 'were'} already read from an earlier copy and ${again === 1 ? 'is' : 'are'} not repeated.</p>` : ''}
  </div>`;
}

function treatmentHtml(cycles, drugs) {
  return `<div class="pc-block"><div class="pc-block-h">Treatment on this sheet</div>
    ${cycles.length ? `<p class="pc-finding">${cycles.map((c) => `Cycle ${esc(c.cycle_no ?? '')}${c.total_cycles ? ` of ${esc(c.total_cycles)}` : ''}${c.regimen_name ? `, ${esc(c.regimen_name)}` : ''}, ${esc(fmtDay(c.administered_on))}`).join('; ')}</p>` : ''}
    ${drugs.length ? `<p class="pc-note">${drugs.map((m) => `${esc(m.name)}${m.dose_raw ? ` ${esc(m.dose_raw)}` : ''}${m.route ? ` ${esc(m.route)}` : ''}`).join('; ')}</p>` : ''}
  </div>`;
}

function cycleHtml(c) {
  const late = num(c.days_later_than_planned);
  return `<article class="pc-item">
    <header><strong>Cycle ${esc(c.cycle_no ?? '')}${c.total_cycles ? ` of ${esc(c.total_cycles)}` : ''}</strong><span class="pc-note">${esc(fmtDay(c.administered_on))}</span></header>
    <div class="pc-tags">${[tag(c.regimen_name),
      tag(num(c.days_since_previous_cycle) !== null ? `${c.days_since_previous_cycle} days after the previous cycle` : 'the first cycle on paper'),
      late !== null ? tag(late > 0 ? `${late} days later than planned` : 'on time', late > 7 ? 'is-warn' : '') : '',
      c.date_written ? tag(`date ${c.date_written}`) : '', tag(c.report_ref)].join('')}</div>
  </article>`;
}

function weightHtml(b) {
  return `<article class="pc-item">
    <header><strong>Weight ${esc(fmtVal(b.weight_kg))} kg</strong><span class="pc-note">${esc(fmtDay(b.measured_on))}</span></header>
    <div class="pc-tags">${[num(b.weight_change_from_first_pct) ? tag(`${b.weight_change_from_first_pct}% since the first weight on file`, num(b.weight_change_from_first_pct) <= -5 ? 'is-warn' : '') : '',
      num(b.height_cm) ? tag(`height ${fmtVal(b.height_cm)} cm`) : '', num(b.bsa_m2) ? tag(`BSA ${fmtVal(b.bsa_m2)} m2`) : '',
      num(b.muac_cm) ? tag(`MUAC ${fmtVal(b.muac_cm)} cm`) : '', tag(b.report_ref)].join('')}</div>
  </article>`;
}

// ============================================================
// Trends and the report list
// ============================================================
function drawTrends(host, fam) {
  const card = host.querySelector('#pc-trends-card');
  const wrap = host.querySelector('#pc-trends');
  const series = [];
  TREND_TESTS.forEach((k) => {
    const pts = fam.labs.filter((l) => l.test_key === k && !l.read_again_from_another_copy && num(l.value_num) !== null && l.tested_on)
      .sort((a, b) => day(a.tested_on).localeCompare(day(b.tested_on)));
    if (pts.length >= 2) series.push({ label: pts[0].test, unit: pts[pts.length - 1].unit || '', pts });
  });
  const weights = fam.body.filter((b) => num(b.weight_kg) !== null && b.measured_on);
  if (weights.length >= 2) series.push({ label: 'Weight', unit: 'kg', pts: weights.map((b) => ({ tested_on: b.measured_on, value_num: b.weight_kg })) });
  if (!series.length) { card.hidden = true; return; }
  card.hidden = false;
  wrap.innerHTML = series.map((s, i) => {
    const last = s.pts[s.pts.length - 1];
    const said = s.pts.map((p) => `${fmtVal(p.value_num)} on ${fmtDay(p.tested_on)}`).join(', ');
    return `<figure class="pc-trend"><figcaption><strong>${esc(s.label)}</strong><span class="pc-note">${esc(fmtVal(last.value_num))} ${esc(s.unit)} on ${esc(fmtDay(last.tested_on))}</span></figcaption>
      <div class="pc-trend-box"><canvas id="pc-tr-${i}" role="img" aria-label="${esc(`${s.label} in ${s.unit}: ${said}`)}"></canvas></div></figure>`;
  }).join('');
  series.forEach((s, i) => drawTrend(`pc-tr-${i}`, s));
}

function drawTrend(id, s) {
  const t0 = dayMs(s.pts[0].tested_on);
  const xs = s.pts.map((p) => (dayMs(p.tested_on) - t0) / DAY_MS);
  const span = Math.max(1, xs[xs.length - 1]);
  const withRange = [...s.pts].reverse().find((p) => num(p.ref_low) !== null || num(p.ref_high) !== null);
  const bound = (v) => (num(v) === null ? null : { data: [{ x: 0, y: num(v) }, { x: span, y: num(v) }], borderColor: CHART_COLORS.slate,
    borderDash: [4, 4], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, fill: false });
  const pointColor = s.pts.map((p) => (OUT_OF_RANGE.includes(p.flag) ? CHART_COLORS.danger : CHART_COLORS.primary));
  createChart(id, 'line', {
    datasets: [
      { label: s.label, data: s.pts.map((p, j) => ({ x: xs[j], y: num(p.value_num) })), borderColor: CHART_COLORS.primary,
        backgroundColor: CHART_COLORS.primary, borderWidth: 2, tension: 0, pointRadius: 4, pointHoverRadius: 6,
        pointBackgroundColor: pointColor, pointBorderColor: pointColor },
      ...[bound(withRange?.ref_low), bound(withRange?.ref_high)].filter(Boolean),
    ],
  }, {
    maintainAspectRatio: false, animation: false,
    // Nearest along x, so the dashed range lines never become the hovered point.
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: { legend: { display: false }, tooltip: { filter: (c) => c.datasetIndex === 0, callbacks: {
      title: (its) => (its.length ? fmtDay(s.pts[its[0].dataIndex]?.tested_on) : ''),
      label: (c) => { const p = s.pts[c.dataIndex] || {}; return ` ${fmtVal(c.parsed.y)} ${s.unit}${OUT_OF_RANGE.includes(p.flag) ? ` (${p.flag})` : ''}`; } } } },
    scales: {
      x: { type: 'linear', min: 0, max: span, ticks: { maxTicksLimit: 4,
        callback: (v) => new Date(t0 + v * DAY_MS).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) } },
      // The app's charts count whole things from zero. A blood value is not
      // a count: haemoglobin 10.2 to 12.4 must not draw flat on a 0 to 20 axis.
      y: { beginAtZero: false, ticks: { maxTicksLimit: 4, precision: undefined } },
    },
  });
}

function drawReports(host, fam, group) {
  const groups = [...new Set(fam.reports.map((r) => r.report_group))];
  host.querySelector('#pc-groups').innerHTML = groups.length > 1 ? ['', ...groups].map((g) => `
    <button type="button" class="pc-chip${g === group ? ' is-on' : ''}" data-group="${esc(g)}" aria-pressed="${g === group}">${esc(g ? laneLabel(g) : 'All')}</button>`).join('') : '';
  const rows = [...fam.reports]
    .sort((a, b) => (a.report_date ? 0 : 1) - (b.report_date ? 0 : 1) || day(a.report_date).localeCompare(day(b.report_date)) || num(a.report_seq) - num(b.report_seq))
    .filter((r) => !group || r.report_group === group);
  host.querySelector('#pc-reports').innerHTML = `
    <thead><tr><th>Date</th><th>Report</th><th>Phase and cycle</th><th>Hospital</th><th>What it says</th><th>Ref</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr class="pc-row" data-report="${esc(r.report_ref)}">
      <td>${r.report_date ? esc(fmtDay(r.report_date)) : `<span class="pc-note">No date (uploaded ${esc(fmtDay(r.uploaded_on))})</span>`}</td>
      <td><span class="pc-mk-inline t-${reportTone(r)}" aria-hidden="true">${esc(reportShort(r))}</span>
        <button type="button" class="pc-linkbtn" data-report="${esc(r.report_ref)}">${esc(r.report_type_label)}</button>${r.repeat_of_earlier ? ` <span class="badge badge-warn" title="${esc(`Repeats ${r.repeats_report || 'an earlier report'}: ${r.repeat_basis}`)}">repeat</span>` : ''}</td>
      <td>${esc(r.care_phase)}${r.cycle_no ? `<span class="pc-note">, after cycle ${esc(r.cycle_no)}</span>` : ''}</td>
      <td>${esc(r.hospital || '')}</td>
      <td class="pc-says">${esc(r.key_finding || '')}</td>
      <td class="pc-note">${esc(r.report_ref)}</td></tr>`).join('') : '<tr><td colspan="6" class="pc-note">No reports on file yet.</td></tr>'}</tbody>`;
}
