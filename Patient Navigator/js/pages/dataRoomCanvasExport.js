// ============================================================
// Patient Navigator: Data room, the patient canvas (downloads)
//
//   downloadFamilyWorkbook(fam)    one family, every table, one .xlsx
//   downloadFamilyTimelineCSV(fam) the merged timeline as one CSV
//   openFamilyPrint(fam)           a clean page to print or save as PDF
//   downloadCohortWorkbook(onStep) every family, every table, one .xlsx
//
// The family workbook carries every tag Priyanka listed on 6 Oct: patient
// code, report date, report type, cancer type, phase of care and cycle,
// hospital, upload date and source, the values on the report, and which copy
// of a report it is. The Timeline sheet, the CSV and the printed page all read
// timelineRows(), so the three can never tell a different story.
//
// SheetJS is loaded here, not through utils/xlsx.js, on purpose: a new export
// there would be a new import into a module GitHub Pages may still serve from
// its ten-minute cache, and a missing export fails the whole module graph
// (tools/stale_import_check.mjs). Same build, same CDN.
// ============================================================

import { exportToCSV } from '../utils/formatters.js';
import { valueLabel } from '../components/analyticsFilters.js';
import {
  esc, num, day, fmtDay, fmtVal, todayIST, cancerLabel, plural, groupRank, rangeText, spanText, papersText,
  whatChanged, timelineRows, runPaged,
} from './dataRoomCanvasData.js';

const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';
let xlsxPromise = null;

function loadXLSX() {
  if (!xlsxPromise) {
    xlsxPromise = import(/* @vite-ignore */ XLSX_CDN).catch(() => {
      xlsxPromise = null;   // a failed load must not poison every later click
      throw new Error('The spreadsheet library could not be loaded. Check the connection, or use the CSV.');
    });
  }
  return xlsxPromise;
}

// utils/xlsx.js cellValue: a code stays text, a count arrives as a string
// from Postgres and must still land as a number.
function cellValue(raw, col) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (col.text) return String(raw);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  if (typeof raw === 'object') return JSON.stringify(raw);
  const s = String(raw);
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s) && s.length <= 15) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

async function writeWorkbook(sheets, filename) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  sheets.filter((s) => s.always || s.rows.length).forEach((s) => {
    const header = s.columns.map((c) => c.label);
    const body = s.rows.map((r) => s.columns.map((c) => cellValue(c.accessor(r), c)));
    const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
    ws['!cols'] = header.map((h, i) => {
      let w = String(h).length;
      for (let r = 0; r < Math.min(body.length, 300); r++) w = Math.max(w, String(body[r][i] ?? '').length);
      return { wch: Math.min(Math.max(w + 2, 8), s.wide ? 90 : 46) };
    });
    if (body.length) {
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: header.length - 1, r: body.length } }) };
    }
    // Excel refuses sheet names over 31 characters or carrying : \ / ? * [ ]
    XLSX.utils.book_append_sheet(wb, ws, s.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31));
  });
  XLSX.writeFile(wb, `${filename}_${todayIST()}.xlsx`);
}

const col = (label, accessor, extra = {}) => ({ label, accessor, ...extra });
const yes = (b) => (b === true ? 'yes' : '');
const stageOf = (s) => (s?.cancer_stage && s.cancer_stage !== 'unknown' ? valueLabel('stage', s.cancer_stage) : '');

// ============================================================
// The sheets
// ============================================================
const TIMELINE_COLS = [
  col('Date', (r) => r.date), col('Date from', (r) => r.basis),
  col('Days from diagnosis', (r) => r.from_diagnosis), col('Day of the JCF journey', (r) => r.journey_day),
  col('Phase of care', (r) => r.phase), col('Cycle', (r) => r.cycle), col('Lane', (r) => r.lane),
  col('What', (r) => r.what), col('Details', (r) => r.detail), col('Hospital', (r) => r.hospital),
  // No text flag: in a CSV it adds a leading tab, and the ref must match the
  // report_ref column of the dataset files exactly to join on.
  col('Report ref', (r) => r.ref),
];

const reportCols = (cancer) => [
  col('Patient code', (r) => r.patient_code, { text: true }), col('Report ref', (r) => r.report_ref, { text: true }),
  col('Report date', (r) => day(r.report_date)), col('Date from', (r) => r.date_basis),
  col('Report type', (r) => r.report_type_label), col('Group', (r) => r.report_group),
  col('Cancer', () => cancer), col('Hospital', (r) => r.hospital),
  col('Phase of care', (r) => r.care_phase), col('Cycle (last on or before)', (r) => r.cycle_no),
  col('Regimen at the time', (r) => r.regimen_at_the_time),
  col('Days from diagnosis', (r) => r.days_from_diagnosis),
  col('Days since first contact with JCF', (r) => r.days_since_first_contact),
  col('Uploaded on', (r) => day(r.uploaded_on)), col('How it reached us', (r) => r.source), col('Pages', (r) => r.pages),
  col('Repeat of an earlier report', (r) => yes(r.repeat_of_earlier)), col('It repeats', (r) => r.repeats_report, { text: true }),
  col('How we know it is a repeat', (r) => r.repeat_basis),
  col('Lab values read', (r) => r.lab_values), col('Lab values outside the range', (r) => r.lab_values_outside_range),
  col('What it says', (r) => r.key_finding), col('Scan', (r) => r.scan_modality),
  col('Scan: change noted', (r) => r.scan_change_noted), col('Scan impression', (r) => r.scan_impression),
  col('Pathology diagnosis', (r) => r.pathology_diagnosis), col('Biomarkers', (r) => r.biomarkers),
  col('Treatment on the report', (r) => r.treatment_on_report),
];

const LAB_COLS = [
  col('Date', (l) => day(l.tested_on)), col('Group', (l) => l.test_group), col('Test', (l) => l.test),
  col('Test as printed', (l) => l.test_as_printed), col('Value', (l) => l.value_num ?? l.value_text), col('Unit', (l) => l.unit),
  col('Range low', (l) => l.ref_low), col('Range high', (l) => l.ref_high), col('Range as printed', (l) => l.ref_text),
  col('Flag', (l) => l.flag), col('Previous value', (l) => l.previous_value), col('Previous date', (l) => day(l.previous_on)),
  col('Change', (l) => (num(l.change_from_previous) === null ? '' : fmtVal(l.change_from_previous))),
  col('Direction', (l) => l.direction), col('Range change', (l) => l.range_change),
  col('Phase of care', (l) => l.care_phase), col('Cycle', (l) => l.cycle_no),
  col('Specimen', (l) => l.specimen), col('Lab', (l) => l.lab_name), col('Report ref', (l) => l.report_ref, { text: true }),
  col('Second copy of a value already read', (l) => yes(l.read_again_from_another_copy)),
];

const SCAN_COLS = [
  col('Date', (x) => day(x.scan_date)), col('Scan', (x) => x.modality), col('Study', (x) => x.study_description),
  col('Why it was done', (x) => x.indication), col('Impression', (x) => x.impression),
  col('Compared with an earlier scan', (x) => yes(x.compares_with_earlier_scan)), col('Change noted', (x) => x.change_noted),
  col('Lesions', (x) => x.lesions), col('New', (x) => x.lesions_new), col('Grew', (x) => x.lesions_increased),
  col('Shrank', (x) => x.lesions_decreased), col('Stable', (x) => x.lesions_stable), col('Resolved', (x) => x.lesions_resolved),
  col('Each lesion', (x) => x.lesion_list), col('Phase of care', (x) => x.care_phase), col('Cycle', (x) => x.cycle_no),
  col('Report ref', (x) => x.report_ref, { text: true }),
];

const PATH_COLS = [
  col('Reported on', (x) => day(x.reported_on)), col('Kind', (x) => x.report_kind), col('Specimen', (x) => x.specimen),
  col('Diagnosis', (x) => x.diagnosis), col('Impression', (x) => x.impression), col('Differentiation', (x) => x.differentiation),
  col('Laboratory', (x) => x.laboratory), col('Phase of care', (x) => x.care_phase), col('Report ref', (x) => x.report_ref, { text: true }),
];

const MARKER_COLS = [
  col('Tested on', (x) => day(x.tested_on)), col('Marker', (x) => x.marker), col('Result', (x) => x.result),
  col('Score', (x) => x.score), col('Interpretation', (x) => x.interpretation), col('Method', (x) => x.method),
  col('Phase of care', (x) => x.care_phase), col('Report ref', (x) => x.report_ref, { text: true }),
];

const REGIMEN_COLS = [
  col('Regimen', (x) => x.regimen_name), col('Intent', (x) => x.intent), col('Planned cycles', (x) => x.total_cycles),
  col('Cycle length (days)', (x) => x.cycle_length_days), col('Started on', (x) => day(x.started_on)), col('Status', (x) => x.status),
  col('Cycles on paper', (x) => x.cycles_recorded), col('First cycle', (x) => day(x.first_cycle_on)),
  col('Last cycle', (x) => day(x.last_cycle_on)), col('Cycles and dates', (x) => x.cycle_list),
  col('Report ref', (x) => x.report_ref, { text: true }),
];

const CYCLE_COLS = [
  col('Given on', (x) => day(x.administered_on)), col('Regimen', (x) => x.regimen_name), col('Cycle', (x) => x.cycle_no),
  col('Of', (x) => x.total_cycles), col('Days since the previous cycle', (x) => x.days_since_previous_cycle),
  col('Days later than planned', (x) => x.days_later_than_planned), col('Date written', (x) => x.date_written),
  col('Report ref', (x) => x.report_ref, { text: true }),
];

const MED_COLS = [
  col('Date', (x) => day(x.on_date)), col('Medicine', (x) => x.name), col('Regimen', (x) => x.regimen),
  col('Dose', (x) => x.dose_raw), col('Route', (x) => x.route), col('How often', (x) => x.frequency),
  col('Days of the cycle', (x) => x.days_of_cycle), col('Supportive (not a cancer drug)', (x) => yes(x.is_supportive)),
  col('Report ref', (x) => x.report_ref, { text: true }),
];

const BODY_COLS = [
  col('Measured on', (x) => day(x.measured_on)), col('Weight (kg)', (x) => x.weight_kg), col('Height (cm)', (x) => x.height_cm),
  col('BSA (m2)', (x) => x.bsa_m2), col('MUAC (cm)', (x) => x.muac_cm),
  col('Weight change since the first (kg)', (x) => x.weight_change_from_first_kg),
  col('Weight change since the first (%)', (x) => x.weight_change_from_first_pct),
  col('Phase of care', (x) => x.care_phase), col('Report ref', (x) => x.report_ref, { text: true }),
];

// The doctor's grid: one row per test, one column per day tested. A flagged
// value carries L or H so it reads in a printout without colour.
export function labMatrix(fam, { keyedOnly = false, lastDays = 0 } = {}) {
  let labs = fam.labs.filter((l) => !l.read_again_from_another_copy && l.tested_on && (!keyedOnly || l.test_key));
  let dates = [...new Set(labs.map((l) => day(l.tested_on)))].sort();
  if (lastDays && dates.length > lastDays) {
    dates = dates.slice(-lastDays);
    // A test seen only before the kept days would be a row of empty cells.
    const kept = new Set(dates);
    labs = labs.filter((l) => kept.has(day(l.tested_on)));
  }
  const tests = new Map();
  labs.forEach((l) => {
    const k = `${l.test_group}|${l.test}|${l.unit || ''}`;
    if (!tests.has(k)) tests.set(k, { group: l.test_group, test: l.test, unit: l.unit || '', range: '', cells: {} });
    const t = tests.get(k);
    const mark = { low: ' L', high: ' H', abnormal: ' *' }[l.flag] || '';
    const v = l.value_num ?? l.value_text;
    t.cells[day(l.tested_on)] = mark ? `${fmtVal(v)}${mark}` : v;
    t.range = t.range || rangeText(l);
  });
  const rows = [...tests.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.test.localeCompare(b.test));
  const columns = [col('Group', (r) => r.group), col('Test', (r) => r.test), col('Unit', (r) => r.unit), col('Range', (r) => r.range),
    ...dates.map((d) => col(fmtDay(d), (r) => r.cells[d] ?? ''))];
  return { rows, columns, dates };
}

const sortedReports = (fam) => [...fam.reports].sort((a, b) =>
  (a.report_date ? 0 : 1) - (b.report_date ? 0 : 1)
  || day(a.report_date).localeCompare(day(b.report_date)) || num(a.report_seq) - num(b.report_seq));

const countEvents = (fam, type, pred = () => true) => fam.events.filter((e) => e.event_type === type && pred(e)).length;

// The Summary sheet, and the "record in short" table of the printed page.
export function summaryPairs(fam) {
  const s = fam.summary || {};
  const p = fam.patient || {};
  const scanLine = s.last_scan
    ? `${s.last_scan}, ${fmtDay(s.last_scan_on)}${s.last_scan_change_noted ? `: ${s.last_scan_change_noted}` : ''}` : '';
  const cycleLine = num(s.cycles_recorded)
    ? `${plural(s.cycles_recorded, 'cycle')} on paper; the last, cycle ${s.last_cycle_no ?? '?'}${s.last_cycle_of ? ` of ${s.last_cycle_of}` : ''} of ${s.last_regimen || 'treatment'}, on ${fmtDay(s.last_cycle_on)}` : '';
  const firstContact = fam.events.find((e) => e.event_type === 'first_contact')?.event_date || s.first_contact_date || p.first_contact_date;
  const pairs = [
    ['Patient code', fam.code],
    ['Prepared on', fmtDay(todayIST())],
    ['Cancer', cancerLabel(s.gi_subtype || s.cancer_type ? s : p)],
    ['Stage', [stageOf(s.cancer_stage ? s : p), s.tnm_stage || p.tnm_stage].filter(Boolean).join(', ')],
    ['Primary site', s.primary_site || p.primary_site],
    ['Histology', s.histology || p.histology],
    ['Diagnosed on', s.diagnosed_on ? `${fmtDay(s.diagnosed_on)} (${s.diagnosed_on_basis})` : 'Not on file'],
    ['Phase of care today, as the papers show it', s.care_phase_today],
    ['Treatment first seen on paper', fmtDay(s.first_treatment_on)],
    ['Treatment last seen on paper', fmtDay(s.last_treatment_on)],
    ['Regimens', s.regimens],
    ['Cycles', cycleLine],
    ['Cycles more than a week late', num(s.cycles_delayed_over_a_week) ? s.cycles_delayed_over_a_week : ''],
    ['First pathology diagnosis', s.first_pathology_diagnosis],
    ['Differentiation', s.differentiation],
    ['Biomarkers', s.biomarker_results],
    ['Latest scan', scanLine],
    ['Latest scan impression', s.last_scan_impression],
    ['Latest blood test', s.last_test_on ? fmtDay(s.last_test_on) : ''],
    ['Outside the range that day', s.last_test_on ? s.last_test_outside_range || 'nothing in the tracked tests' : ''],
    ['Latest weight', num(s.latest_weight_kg) !== null
      ? `${fmtVal(s.latest_weight_kg)} kg on ${fmtDay(s.latest_weight_on)}${num(s.weight_change_pct) ? ` (${s.weight_change_pct}% since the first)` : ''}` : ''],
    ['Reports on file', num(s.reports)
      ? `${s.reports} (${s.reports_dated} dated)${s.first_report_on ? `, ${spanText(s.first_report_on, s.last_report_on)}` : ''}` : 'none'],
    ['Reports by kind', papersText(s)],
    ['Hospitals', s.hospitals],
    ['Uploads that could not be read', num(s.reports_not_read) ? s.reports_not_read : ''],
    ['First contact with JCF', fmtDay(firstContact)],
    ['Calls connected', countEvents(fam, 'call_placed', (e) => e.code === 'connected')],
    ['Needs raised', countEvents(fam, 'need_raised')],
    ['Support delivered', countEvents(fam, 'support_delivered')],
    ['Concerns escalated', countEvents(fam, 'concern_raised')],
  ];
  // The AI summary, when the canvas loaded one: clearly marked, with its refs.
  const ai = fam.ai?.summary;
  if (ai) {
    if (fam.ai.notice) pairs.push(['From the record', fam.ai.notice]);
    const lines = [ai.headline, ...(ai.points || []).map((p) => `${p.text} [${(p.refs || []).join(', ')}]`)].filter(Boolean);
    lines.forEach((t, i) => pairs.push([i === 0 ? `Summary written by AI (${fam.ai.model}), not reviewed by a person; check against the reports` : '', t]));
    (ai.not_on_file || []).forEach((g, i) => pairs.push([i === 0 ? 'Not on the papers (AI)' : '', g]));
  }
  whatChanged(fam).forEach((w, i) => pairs.push([i === 0 ? 'What changed' : '', w.text]));
  pairs.push(['Note', 'De-identified: patient code only. Read off the papers the family shared with JCF and reviewed by a mentor. Phases of care are as the papers on file show them, not a clinical judgement.']);
  return pairs.filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => ({ k, v }));
}

// ============================================================
// One family
// ============================================================
export async function downloadFamilyWorkbook(fam) {
  const cancer = cancerLabel(fam.summary || fam.patient);
  const grid = labMatrix(fam);
  await writeWorkbook([
    { name: 'Summary', always: true, wide: true, rows: summaryPairs(fam), columns: [col('What', (r) => r.k), col('Detail', (r) => r.v)] },
    { name: 'Timeline', always: true, rows: timelineRows(fam), columns: TIMELINE_COLS },
    { name: 'Reports', always: true, rows: sortedReports(fam), columns: reportCols(cancer) },
    { name: 'Blood tests by date', rows: grid.rows, columns: grid.columns },
    { name: 'Blood tests', rows: fam.labs, columns: LAB_COLS },
    { name: 'Scans', rows: fam.scans, columns: SCAN_COLS },
    { name: 'Pathology', rows: fam.pathology, columns: PATH_COLS },
    { name: 'Markers', rows: fam.biomarkers, columns: MARKER_COLS },
    { name: 'Regimens', rows: fam.treatment, columns: REGIMEN_COLS },
    { name: 'Cycles', rows: fam.cycles, columns: CYCLE_COLS },
    { name: 'Medicines', rows: fam.medicines, columns: MED_COLS },
    { name: 'Weight', rows: fam.body, columns: BODY_COLS },
  ], `jcf_patient_${fam.code}`);
}

export function downloadFamilyTimelineCSV(fam) {
  const rows = timelineRows(fam);
  if (rows.length) exportToCSV(rows, `jcf_patient_${fam.code}_timeline`, TIMELINE_COLS);
  return rows.length;
}

// ============================================================
// The printed page. A page of its own, so it prints the same from every
// theme and every screen size, and "Save as PDF" in the print dialog turns it
// into the PDF a doctor asks for.
// ============================================================
const PRINT_CSS = `
  :root { color-scheme: light; }
  body { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1c1b1a; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #c9c4c0; }
  .sub, .note { color: #4f4a46; }
  .sub { margin: 0 0 12px; }
  .note { font-size: 11px; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
  .bar button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #1c1b1a; background: #1c1b1a; color: #fff; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
  th, td { border: 1px solid #d9d4d0; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f3f0ee; }
  td.k { width: 30%; color: #4f4a46; }
  ul { margin: 0; padding-left: 18px; }
  .bad { color: #a40000; font-weight: 600; } .warn { color: #7a4a00; font-weight: 600; } .good { color: #1e6a4f; font-weight: 600; }
  @media print { .bar { display: none; } body { margin: 12mm; } h2 { break-after: avoid; } tr { break-inside: avoid; } }`;

function printHtml(fam) {
  const s = fam.summary || {};
  const changed = whatChanged(fam);
  const reports = sortedReports(fam);
  const grid = labMatrix(fam, { keyedOnly: true, lastDays: 8 });
  const allDays = labMatrix(fam, { keyedOnly: true }).dates.length;
  const sub = [cancerLabel(s.gi_subtype || s.cancer_type ? s : fam.patient), stageOf(s),
    s.diagnosed_on ? `diagnosed ${fmtDay(s.diagnosed_on)}` : '',
    num(s.reports) ? `${plural(s.reports, 'report')}${s.first_report_on ? `, ${spanText(s.first_report_on, s.last_report_on)}` : ''}` : ''].filter(Boolean);
  const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(fam.code)}: medical record</title>
<style>${PRINT_CSS}</style></head><body>
<div class="bar"><span class="note">Patient Navigator Data room. De-identified: patient code only.</span>
<button type="button" onclick="window.print()">Print or save as PDF</button></div>
<h1>${esc(fam.code)}</h1>
<p class="sub">${sub.map(esc).join(' · ')}</p>
${fam.ai?.summary ? `<h2>Summary written by AI, not reviewed by a person</h2>
${fam.ai.notice ? `<p><strong>${esc(fam.ai.notice)}</strong> <span class="note">(from the record, not from the AI)</span></p>` : ''}
<p class="note">The dates, figures, stage and low or high flags in each point were matched to the reports it cites. Open the report before relying on a sentence.</p>
${fam.ai.summary.headline ? `<p><strong>${esc(fam.ai.summary.headline)}</strong></p>` : ''}
<ul>${(fam.ai.summary.points || []).map((p) => `<li>${esc(p.text)} <span class="note">[${esc((p.refs || []).join(', '))}]</span></li>`).join('')}</ul>
${(fam.ai.summary.not_on_file || []).length ? `<p class="note">Not on the papers: ${esc(fam.ai.summary.not_on_file.join('; '))}</p>` : ''}` : ''}
<h2>What changed</h2>
${changed.length ? `<ul>${changed.map((w) => `<li class="${w.tone === 'plain' ? '' : esc(w.tone)}">${esc(w.text)}</li>`).join('')}</ul>` : '<p class="note">Nothing on the papers says anything changed.</p>'}
<h2>The record in short</h2>
<table><tbody>${summaryPairs(fam).filter((x) => x.k !== 'What changed' && x.k !== '' && x.k !== 'Note')
    .map((x) => `<tr><td class="k">${esc(x.k)}</td><td>${esc(x.v)}</td></tr>`).join('')}</tbody></table>
<h2>Every report, in date order</h2>
${reports.length ? table(['Date', 'Report', 'Phase and cycle', 'Hospital', 'What it says', 'Ref'], reports.map((r) => `<tr>
  <td>${r.report_date ? esc(fmtDay(r.report_date)) : `No date (uploaded ${esc(fmtDay(r.uploaded_on))})`}</td>
  <td>${esc(r.report_type_label)}${r.repeat_of_earlier ? ` (repeats ${esc(r.repeats_report || 'an earlier report')})` : ''}</td>
  <td>${esc(r.care_phase)}${r.cycle_no ? `, after cycle ${esc(r.cycle_no)}` : ''}</td>
  <td>${esc(r.hospital || '')}</td><td>${esc(r.key_finding || '')}</td><td>${esc(r.report_ref)}</td></tr>`)) : '<p class="note">No reports on file.</p>'}
${grid.rows.length ? `<h2>Blood tests by date</h2>
${allDays > grid.dates.length ? `<p class="note">The last ${grid.dates.length} of ${allDays} test days. L is below the range, H above it. The workbook has every day and every test.</p>` : '<p class="note">L is below the range, H above it.</p>'}
${table(grid.columns.map((c) => c.label), grid.rows.map((r) => `<tr>${grid.columns.map((c) => `<td>${esc(c.accessor(r))}</td>`).join('')}</tr>`))}` : ''}
${fam.cycles.length ? `<h2>Treatment cycles</h2>${table(['Given on', 'Regimen', 'Cycle', 'Days since the previous', 'Days late'], fam.cycles.map((c) => `<tr>
  <td>${esc(fmtDay(c.administered_on))}</td><td>${esc(c.regimen_name || '')}</td>
  <td>${esc(c.cycle_no ?? '')}${c.total_cycles ? ` of ${esc(c.total_cycles)}` : ''}</td>
  <td>${esc(c.days_since_previous_cycle ?? '')}</td><td>${num(c.days_later_than_planned) > 0 ? esc(c.days_later_than_planned) : ''}</td></tr>`))}` : ''}
${fam.scans.length ? `<h2>Scans</h2>${table(['Date', 'Scan', 'Change noted', 'Impression'], fam.scans.map((x) => `<tr>
  <td>${esc(fmtDay(x.scan_date))}</td><td>${esc(x.modality)}</td><td>${esc(x.change_noted || '')}</td><td>${esc(x.impression || '')}</td></tr>`))}` : ''}
<p class="note" style="margin-top:18px">Prepared ${esc(fmtDay(todayIST()))}. Read off the papers the family shared with JCF and reviewed by a mentor. Phases of care are as the papers on file show them, not a clinical judgement.</p>
</body></html>`;
}

export function openFamilyPrint(fam) {
  const url = URL.createObjectURL(new Blob([printHtml(fam)], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) {
    // A blocked pop-up still gets the page, as a file to open and print.
    const a = document.createElement('a');
    a.href = url;
    a.download = `jcf_patient_${fam.code}_${todayIST()}.html`;
    a.click();
  } else {
    w.addEventListener('load', () => { try { w.focus(); w.print(); } catch { /* the page has its own button */ } });
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return !!w;
}

// ============================================================
// Every family, every table: one workbook. Sequential on purpose: eleven
// queries at once is how the Data room met its 8 s ceiling before sql/139.
// ============================================================
const COHORT = [
  ['Summary', 'medical_summary', 'patient_code'],
  ['Reports', 'reports', 'patient_code, report_seq'],
  ['Blood tests', 'lab_results', 'patient_code, test_group, test, tested_on'],
  ['Scans', 'scans', 'patient_code, scan_date'],
  ['Pathology', 'pathology', 'patient_code, reported_on'],
  ['Markers', 'biomarkers', 'patient_code, tested_on, marker'],
  ['Regimens', 'treatment', 'patient_code, regimen_name'],
  ['Cycles', 'treatment_cycles', 'patient_code, administered_on'],
  ['Medicines', 'medications', 'patient_code, on_date, name'],
  ['Weight', 'body_measurements', 'patient_code, measured_on'],
  ['Medical timeline', 'medical_timeline', 'patient_code, event_date, event_order'],
];

export async function downloadCohortWorkbook(onStep) {
  const sheets = [];
  for (let i = 0; i < COHORT.length; i++) {
    const [name, view, order] = COHORT[i];
    onStep?.(i + 1, COHORT.length, name);
    const rows = await runPaged(`select * from ${view}`, order);
    const keys = rows.length ? Object.keys(rows[0]) : ['patient_code'];
    sheets.push({ name, always: true, rows, columns: keys.map((k) => col(k, (r) => r[k], k === 'patient_code' || k === 'report_ref' ? { text: true } : {})) });
  }
  await writeWorkbook(sheets, 'jcf_medical_record_every_family');
  return { families: sheets[0].rows.length, reports: sheets[1].rows.length };
}
