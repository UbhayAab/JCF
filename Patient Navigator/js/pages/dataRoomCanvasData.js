// ============================================================
// Patient Navigator: Data room, the patient canvas (what it reads)
//
// One family's whole record from the sql/158 views (reports, lab values,
// scans, pathology, markers, regimens, cycles, medicines, weight) and the
// sql/138 timeline (calls, needs, support, concerns), plus what the canvas
// works out from them: the lanes, the "what changed" lines and one merged
// timeline. dataRoomCanvas.js draws it; dataRoomCanvasExport.js writes it.
//
//   loadFamily(code)   every table for one family
//   loadRoster()       the picker: families with papers, and every code
//   whatChanged(fam)   changes between reports, worked out from the papers
//   timelineRows(fam)  medical and journey events, one date-ordered list
//   canvasDefs()       the per-table download cards for the Datasets tab
//
// Every query goes through data_room_run, the same validated, de-identified,
// role-gated door as the rest of the Data room. It refuses whole words such
// as call, set, do and lock anywhere in the SQL text, literals included, so
// no query here may use them. That is why the journey event is call_placed.
// ============================================================

import { getSupabase } from '../supabase.js';
import { giLabel, leverLabel, measureLabel, concernReason } from '../utils/catalog.js';

export const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_ROWS = 50000;            // data_room_run's hard cap per call
const DAY_MS = 864e5;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (x) => (x === null || x === undefined || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
export const day = (x) => (x ? String(x).slice(0, 10) : '');
// Report dates are calendar days, not instants. Kept in UTC so no timezone
// can move a report to the day before.
export const dayMs = (x) => {
  const s = day(x);
  const t = s ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : NaN;
  return Number.isFinite(t) ? t : null;   // 'infinity' or a stray string is no date at all
};
export const fmtDay = (x) => (day(x)
  ? new Date(dayMs(x)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
export const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => (dayMs(a) === null || dayMs(b) === null ? null : Math.round((dayMs(b) - dayMs(a)) / DAY_MS));
export const fmtVal = (x) => (num(x) === null ? String(x ?? '') : String(Math.round(num(x) * 100) / 100));
export const valueText = (l) => `${l.value_text ?? fmtVal(l.value_num)}${l.unit ? ' ' + l.unit : ''}`;
export const cancerLabel = (s) => giLabel(s?.gi_subtype) || s?.cancer_type || 'Cancer type not recorded';
export const plural = (n, one, many = one + 's') => `${n} ${Number(n) === 1 ? one : many}`;
// "26 Aug 2026", not "26 Aug 2026 to 26 Aug 2026", when a span is one day.
export const spanText = (a, b) => (day(a) === day(b) ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`);

// "5 reports: 2 scans, 3 blood tests": only the kinds there are.
export function papersText(s) {
  if (!num(s?.reports)) return '';
  const kinds = [[s.scan_reports, 'scan'], [s.pathology_reports, 'pathology report'], [s.lab_reports, 'blood test report'],
    [s.treatment_papers, 'treatment sheet'], [s.hospital_papers, 'hospital paper'], [s.clinic_notes, 'clinic note'],
    [s.other_papers, 'other paper']].filter(([n]) => num(n) > 0).map(([n, what]) => plural(n, what));
  return `${plural(s.reports, 'report')}${kinds.length ? ': ' + kinds.join(', ') : ''}`;
}

// dataroom.test_group() names, in the order a doctor reads a report.
export const TEST_GROUPS = ['Blood count (CBC)', 'Liver (LFT)', 'Kidney and salts (KFT)', 'Tumour markers', 'Sugar',
  'Clotting', 'Inflammation', 'Thyroid, hormones and vitamins', 'Infection screen', 'Urine', 'Cultures', 'Other tests'];
export const groupRank = (g) => { const i = TEST_GROUPS.indexOf(g); return i < 0 ? 99 : i; };
export const rangeText = (l) => {
  if (l.ref_text) return l.ref_text;
  const lo = num(l.ref_low), hi = num(l.ref_high);
  if (lo !== null && hi !== null) return `${fmtVal(lo)} to ${fmtVal(hi)}`;
  if (hi !== null) return `up to ${fmtVal(hi)}`;
  if (lo !== null) return `${fmtVal(lo)} or more`;
  return '';
};

export async function run(sql, limit = PAGE_ROWS) {
  const { data, error } = await getSupabase().rpc('data_room_run', { p_sql: sql, p_limit: limit });
  if (error) throw new Error(error.message);
  if (!data || data.ok !== true) throw new Error(data?.reason || 'the Data room refused this query');
  return data.rows || [];
}

// Page on a stable order until a short page comes back, so nobody silently
// gets the first 50,000 rows only.
export async function runPaged(sql, order) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const page = await run(`${sql} order by ${order} limit ${PAGE_ROWS} offset ${offset}`);
    rows.push(...page);
    if (page.length < PAGE_ROWS) return rows;
  }
}

// A browser call runs under an 8 s statement timeout (sql/139). Twelve small
// queries four at a time keep the database calm and the tab under a second.
async function inBatches(tasks, width = 4) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

// ============================================================
// Reading one family
// ============================================================
const FAMILY = {
  summary:    (c) => `select * from medical_summary where patient_code = '${c}'`,
  patient:    (c) => `select patient_code, age_band, gender, state, gi_subtype, cancer_type, cancer_stage, tnm_stage,
                       primary_site, histology, trajectory, diagnosis_date, patient_status, first_contact_date
                      from patients where patient_code = '${c}'`,
  reports:    (c) => `select * from reports where patient_code = '${c}' order by timeline_date, report_seq`,
  labs:       (c) => `select * from lab_results where patient_code = '${c}' order by test_group, test, tested_on`,
  scans:      (c) => `select * from scans where patient_code = '${c}' order by scan_date`,
  pathology:  (c) => `select * from pathology where patient_code = '${c}' order by reported_on`,
  biomarkers: (c) => `select * from biomarkers where patient_code = '${c}' order by tested_on, marker`,
  treatment:  (c) => `select * from treatment where patient_code = '${c}' order by first_cycle_on, regimen_name`,
  cycles:     (c) => `select * from treatment_cycles where patient_code = '${c}' order by administered_on, cycle_no`,
  medicines:  (c) => `select * from medications where patient_code = '${c}' order by on_date, name`,
  body:       (c) => `select * from body_measurements where patient_code = '${c}' order by measured_on`,
  events:     (c) => `select event_date, event_order, event_type, code, value, detail, channel
                      from timeline where patient_code = '${c}' and event_type <> 'mentor_assigned'
                      order by event_date, event_order`,
};

export async function loadFamily(code) {
  if (!CODE_RE.test(code)) throw new Error('That is not a patient code.');
  const keys = Object.keys(FAMILY);
  const rows = await inBatches(keys.map((k) => () => run(FAMILY[k](code))));
  const fam = Object.fromEntries(keys.map((k, i) => [k, rows[i]]));
  fam.code = code;
  fam.summary = fam.summary[0] || null;
  fam.patient = fam.patient[0] || null;
  return fam;
}

export async function loadRoster() {
  const [withPapers, everyone] = await Promise.all([
    run(`select patient_code, gi_subtype, cancer_type, reports, reports_dated, first_report_on, last_report_on,
                last_upload_on, scans, lab_values, lab_values_outside_range, cycles_recorded, care_phase_today
         from medical_summary`),
    run('select patient_code from patients order by patient_code', 5000),
  ]);
  return { withPapers, codes: everyone.map((r) => r.patient_code) };
}

// ============================================================
// What the canvas draws
// ============================================================

// Top to bottom. The first nine keys are report_group values from sql/158.
export const LANES = [
  { key: 'Scans', label: 'Scans' },
  { key: 'Pathology and biopsy', label: 'Pathology and markers' },
  { key: 'Blood and lab tests', label: 'Blood tests' },
  { key: 'Treatment', label: 'Treatment and cycles' },
  { key: 'Weight', label: 'Weight' },
  { key: 'Hospital stays and procedures', label: 'Hospital stays' },
  { key: 'Clinic notes and referrals', label: 'Clinic notes' },
  { key: 'Costs and schemes', label: 'Costs and schemes' },
  { key: 'Registration and other papers', label: 'Other papers' },
  { key: 'Calls', label: 'Calls with JCF' },
  { key: 'Care', label: 'Needs, support, concerns' },
];
export const laneLabel = (key) => LANES.find((l) => l.key === key)?.label || key;

const SHORT = {
  radiology_report: 'Scan', imaging_report: 'Scan',
  histopathology: 'Biopsy', pathology_addendum: 'Addendum', laboratory_report: 'Lab',
  treatment_protocol: 'Protocol', drug_calculation: 'Drugs', nursing_record: 'Nursing', prescription: 'Rx',
  transfusion_record: 'Blood', device_record: 'PICC', discharge_summary: 'Discharge', endoscopy_report: 'Endoscopy',
  consent_form: 'Consent', opd_note: 'OPD', referral_letter: 'Referral', cost_certificate: 'Cost',
  bill_receipt: 'Bill', scheme_card: 'Scheme', income_certificate: 'Income', disability_certificate: 'Disability',
  ration_card: 'Ration', insurance_document: 'Insurance', ngo_sanction_letter: 'Sanction',
  registration_form: 'Reg', file_cover: 'File', id_card: 'ID',
};
const SCAN_SHORT = { 'PET-CT': 'PET', Ultrasound: 'USG' };

export const reportShort = (r) => (r.scan_modality ? SCAN_SHORT[r.scan_modality] || r.scan_modality : SHORT[r.report_type] || 'Doc');

// The colour a report earns from what is on it. Red is reserved for what a
// scan says grew; abnormal blood values are amber because most chemotherapy
// blood counts have something outside the range.
export function reportTone(r) {
  if (r.scan_change_noted === 'growth or new disease noted') return 'bad';
  if (r.scan_change_noted === 'shrinkage noted') return 'good';
  if (num(r.lab_values_outside_range) > 0) return 'warn';
  if (r.pathology_diagnosis || r.biomarkers) return 'info';
  return 'plain';
}

const sentence = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// The journey events worth a marker. An unanswered dial attempt is not: a
// family rung ten times before anyone picked up would bury everything else.
export function journeyLook(e) {
  switch (e.event_type) {
    case 'first_contact': return { lane: 'Care', short: 'JCF', tone: 'info', label: 'First contact with JCF' };
    case 'call_placed':
      return e.code === 'connected'
        ? { lane: 'Calls', short: '', tone: 'plain', label: `Call, connected${num(e.value) ? `, ${e.value} min` : ''}` } : null;
    case 'need_raised': return { lane: 'Care', short: 'Need', tone: 'warn', label: `Need raised: ${e.code}` };
    case 'support_delivered': return { lane: 'Care', short: 'Help', tone: 'good', label: `Support delivered: ${leverLabel(e.code)}` };
    case 'resources_sent': return { lane: 'Care', short: 'Sent', tone: 'plain', label: 'Resources sent on WhatsApp' };
    case 'concern_raised':
      return { lane: 'Care', short: '!', tone: 'bad', label: `Concern escalated: ${concernReason(e.code)?.label || sentence(e.code)}` };
    case 'concern_resolved': return { lane: 'Care', short: 'OK', tone: 'good', label: 'Concern resolved' };
    case 'session_held': return { lane: 'Care', short: '1:1', tone: 'good', label: `${sentence(e.code)} session held` };
    case 'wellbeing_reading':
      return { lane: 'Care', short: 'Score', tone: 'plain', label: `${measureLabel(e.code)}: ${e.value}${e.detail ? ` (${e.detail})` : ''}` };
    case 'status_changed': return { lane: 'Care', short: 'Status', tone: 'plain', label: `Status: ${sentence(e.code)}` };
    case 'death': return { lane: 'Care', short: 'Died', tone: 'bad', label: 'Death' };
    default: return null;
  }
}

// dataroom.care_phase(), for dates the views do not phase (journey events).
export function phaseOn(date, s) {
  if (!day(date)) return 'Undated';
  const tx = day(s?.first_treatment_on), dx = day(s?.diagnosed_on);
  if (tx) return day(date) < tx ? 'At diagnosis' : 'During treatment';
  if (dx && daysBetween(dx, date) <= 60) return 'At diagnosis';
  return 'Phase not known';
}

// The latest first-copy reading of every test a trend is drawn for.
export function latestByTest(labs) {
  const best = new Map();
  labs.filter((l) => l.test_key && !l.read_again_from_another_copy && l.tested_on).forEach((l) => {
    const cur = best.get(l.test_key);
    if (!cur || day(l.tested_on) > day(cur.tested_on)
        || (day(l.tested_on) === day(cur.tested_on) && num(l.reading_seq) > num(cur.reading_seq))) best.set(l.test_key, l);
  });
  return [...best.values()];
}

const byDay = (k) => (a, b) => day(a[k]).localeCompare(day(b[k]));

// ============================================================
// What changed between reports, worked out from the papers alone. Newest
// first; the notes about the papers themselves come last.
// ============================================================
export function whatChanged(fam) {
  const out = [];
  const s = fam.summary || {};

  const scans = fam.scans.filter((x) => x.scan_date).sort(byDay('scan_date'));
  const lastScan = scans[scans.length - 1];
  if (lastScan?.change_noted) {
    const tone = lastScan.change_noted.startsWith('growth') ? 'bad' : lastScan.change_noted.startsWith('shrink') ? 'good' : 'plain';
    out.push({ tone, date: lastScan.scan_date,
      text: `${lastScan.modality} on ${fmtDay(lastScan.scan_date)}: ${lastScan.change_noted}${lastScan.compares_with_earlier_scan ? ', compared with an earlier scan' : ''}.` });
  }

  latestByTest(fam.labs).forEach((l) => {
    const was = num(l.previous_value) !== null ? ` (was ${fmtVal(l.previous_value)} on ${fmtDay(l.previous_on)})` : '';
    if (l.range_change) {
      out.push({ tone: l.range_change === 'moved out of range' ? 'warn' : 'good', date: l.tested_on,
        text: `${l.test} ${valueText(l)} on ${fmtDay(l.tested_on)}: ${l.range_change}${was}.` });
    } else if (['cea', 'ca19_9', 'ca125'].includes(l.test_key) && num(l.previous_value) > 0
               && num(l.value_num) >= num(l.previous_value) * 1.2) {
      out.push({ tone: 'warn', date: l.tested_on,
        text: `${l.test} rose from ${fmtVal(l.previous_value)} to ${valueText(l)} between ${fmtDay(l.previous_on)} and ${fmtDay(l.tested_on)}.` });
    }
  });

  if (num(s.weight_change_pct) !== null && num(s.weight_change_pct) <= -5) {
    out.push({ tone: 'warn', date: s.latest_weight_on,
      text: `Weight ${fmtVal(s.latest_weight_kg)} kg on ${fmtDay(s.latest_weight_on)}: down ${Math.abs(num(s.weight_change_pct))}% since the first weight on file.` });
  }

  fam.cycles.filter((c) => num(c.days_later_than_planned) > 7).forEach((c) => out.push({ tone: 'warn', date: c.administered_on,
    text: `Cycle ${c.cycle_no ?? ''} of ${c.regimen_name || 'treatment'} on ${fmtDay(c.administered_on)} was ${c.days_later_than_planned} days later than planned.` }));

  // Only when the papers say more cycles are due: a planned total not yet
  // reached, a regimen not marked completed or stopped, a patient alive.
  const lastCycle = [...fam.cycles].sort(byDay('administered_on')).pop();
  const plan = num(lastCycle?.cycle_length_days);
  const regimen = lastCycle ? fam.treatment.find((t) => t.regimen_name === lastCycle.regimen_name) : null;
  const moreDue = lastCycle && num(lastCycle.total_cycles) !== null && num(lastCycle.cycle_no) !== null
    && num(lastCycle.cycle_no) < num(lastCycle.total_cycles)
    && !['completed', 'stopped'].includes(regimen?.status)
    && fam.patient?.patient_status !== 'deceased';
  if (moreDue && plan) {
    const gap = daysBetween(lastCycle.administered_on, todayIST());
    if (gap > 2 * plan) {
      out.push({ tone: 'plain', date: lastCycle.administered_on,
        text: `The papers stop at cycle ${lastCycle.cycle_no ?? '?'}${lastCycle.total_cycles ? ` of ${lastCycle.total_cycles}` : ''} on ${fmtDay(lastCycle.administered_on)}, ${gap} days ago, on a ${plan}-day plan. The later sheets may be worth asking the family for.` });
    }
  }

  const notes = [];
  if (num(s.reports_not_read) > 0) notes.push({ tone: 'plain', date: null,
    text: `${plural(s.reports_not_read, 'uploaded report')} could not be read, so ${num(s.reports_not_read) === 1 ? 'it is' : 'they are'} not on this canvas.` });
  const undated = fam.reports.filter((r) => !r.report_date).length;
  if (undated) notes.push({ tone: 'plain', date: null,
    text: `${plural(undated, 'report')} ${undated === 1 ? 'carries' : 'carry'} no date, so ${undated === 1 ? 'it sits' : 'they sit'} under the timeline, not on it.` });
  if (num(s.reports_filed_twice) > 0) notes.push({ tone: 'plain', date: null,
    text: `${plural(s.reports_filed_twice, 'report')} ${num(s.reports_filed_twice) === 1 ? 'repeats' : 'repeat'} an earlier upload (the same photographs, or every value already read); ${num(s.reports_filed_twice) === 1 ? 'it is' : 'they are'} marked and ${num(s.reports_filed_twice) === 1 ? 'its' : 'their'} values counted once.` });

  out.sort((a, b) => day(b.date).localeCompare(day(a.date)));
  return [...out, ...notes];
}

// ============================================================
// Medical and journey events as one date-ordered list: the Timeline sheet,
// the CSV and the printed page all read this, so they cannot disagree.
// ============================================================
export function timelineRows(fam) {
  const s = fam.summary || {};
  const dx = day(s.diagnosed_on);
  const fc = day(s.first_contact_date || fam.patient?.first_contact_date);
  const rows = [];
  fam.reports.forEach((r) => rows.push({
    date: day(r.timeline_date), basis: r.report_date ? 'date on the report' : 'no date on the report: upload date',
    lane: laneLabel(r.report_group),
    what: r.report_type_label + (r.repeat_of_earlier ? ` (repeats ${r.repeats_report || 'an earlier report'})` : ''),
    detail: r.key_finding || '', hospital: r.hospital || '', phase: r.care_phase, cycle: r.cycle_no ?? '',
    ref: r.report_ref, order: 1 }));
  fam.cycles.forEach((c) => rows.push({
    date: day(c.administered_on), basis: 'date on the treatment sheet', lane: laneLabel('Treatment'),
    what: c.cycle_no === null || c.cycle_no === undefined ? 'Cycle'
      : `Cycle ${c.cycle_no}${c.total_cycles ? ` of ${c.total_cycles}` : ''}`,
    detail: [c.regimen_name, num(c.days_later_than_planned) > 0 ? `${c.days_later_than_planned} days later than planned` : '']
      .filter(Boolean).join('; '),
    hospital: '', phase: 'During treatment', cycle: c.cycle_no ?? '', ref: c.report_ref || '', order: 2 }));
  fam.body.filter((b) => num(b.weight_kg) !== null).forEach((b) => rows.push({
    date: day(b.measured_on), basis: 'date on the sheet', lane: laneLabel('Weight'), what: `Weight ${fmtVal(b.weight_kg)} kg`,
    detail: num(b.weight_change_from_first_pct) ? `${b.weight_change_from_first_pct}% since the first weight on file` : '',
    hospital: '', phase: b.care_phase, cycle: '', ref: b.report_ref || '', order: 3 }));
  fam.events.forEach((e) => {
    const j = journeyLook(e);
    if (j) rows.push({ date: day(e.event_date), basis: 'JCF record', lane: laneLabel(j.lane), what: j.label, detail: '',
      hospital: '', phase: phaseOn(e.event_date, s), cycle: '', ref: '', order: 4 + num(e.event_order || 0) / 100 });
  });
  rows.forEach((x) => {
    x.from_diagnosis = dx ? daysBetween(dx, x.date) ?? '' : '';
    x.journey_day = fc ? daysBetween(fc, x.date) ?? '' : '';
  });
  return rows.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.order - b.order);
}

// ============================================================
// The Datasets tab cards: one table each, every family, the cohort filter
// applied through patient_code like the journey cards.
// ============================================================
const DATASETS = [
  { view: 'medical_summary', order: 'patient_code', ico: 'users', file: 'jcf_medical_record_per_family',
    name: 'Medical record, one row per family',
    desc: 'START HERE. One row per family with medical papers: diagnosis and how it was dated, reports of each kind and the span they cover, hospitals, the latest scan and what it says changed, pathology, markers, regimens, cycles and delays, the latest blood test and weight. Patient codes only.' },
  { view: 'reports', order: 'patient_code, report_seq', ico: 'fileText', file: 'jcf_medical_reports',
    name: 'Every report, with its tags',
    desc: 'One row per report on file: the date printed on it, its type and group, the hospital, the phase of care and chemotherapy cycle it falls in, when and how it reached us, whether it is a second copy, and one line on what it says.' },
  { view: 'lab_results', order: 'patient_code, test_group, test, tested_on', ico: 'activity', file: 'jcf_lab_values',
    name: 'Every blood and lab value',
    desc: 'One row per value read off a report (CBC, LFT, KFT, tumour markers and the rest) with its range and flag, one name per test across hospitals, and the change from the family\'s previous reading of the same test.' },
  { view: 'scans', order: 'patient_code, scan_date', ico: 'eye', file: 'jcf_scans',
    name: 'Scans, with what changed',
    desc: 'PET-CT, CT, MRI, ultrasound and X-ray reports: the impression, and for repeat scans the lesions that are new, grew, shrank or held, as the report itself says.' },
  { view: 'pathology', order: 'patient_code, reported_on', ico: 'stethoscope', file: 'jcf_pathology',
    name: 'Biopsy and pathology reports',
    desc: 'Histopathology, cytology, frozen sections and addenda: what was sampled, the diagnosis and the differentiation.' },
  { view: 'biomarkers', order: 'patient_code, tested_on, marker', ico: 'key', file: 'jcf_biomarkers',
    name: 'Genetic and molecular markers',
    desc: 'IHC stains, mismatch repair and MSI, HER2 and the like, one row per marker per test, with result, score and interpretation as printed.' },
  { view: 'treatment', order: 'patient_code, regimen_name', ico: 'heartPulse', file: 'jcf_treatment_regimens',
    name: 'Treatment regimens',
    desc: 'One row per chemotherapy or targeted regimen on a protocol sheet: intent, planned cycles and cycle length, and the cycles recorded against it with their dates.' },
  { view: 'treatment_cycles', order: 'patient_code, administered_on', ico: 'calendar', file: 'jcf_treatment_cycles',
    name: 'Treatment cycles, with delays',
    desc: 'Every recorded cycle with its regimen, the days since the previous cycle and how many days later than planned it was.' },
];

const cell = (x) => (x === null || x === undefined ? '' : typeof x === 'boolean' ? String(x) : x);

export function canvasDefs() {
  return DATASETS.map((d) => ({
    key: 'medical_' + d.view, research: true, medical: true, ico: d.ico, pid: null,
    code: (r) => r.patient_code,
    name: d.name, desc: d.desc, file: d.file, countFrom: null,
    build: async () => {
      const rows = await runPaged(`select * from ${d.view}`, d.order);
      const columns = rows.length ? Object.keys(rows[0]).map((k) => ({ label: k, accessor: (r) => cell(r[k]) })) : [];
      return { rows, columns };
    },
  }));
}
