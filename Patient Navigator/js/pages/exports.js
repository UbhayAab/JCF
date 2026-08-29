// ============================================================
// Patient Navigator: Data room
// Self-serve raw-data CSV downloads, so researchers stop asking
// for ad-hoc Excel files over WhatsApp. One card per dataset,
// live row counts, one click → the full raw file: they put the
// filters on their own. Research-grade datasets are de-identified
// (patient codes, never names or phones) and are the ONLY ones
// the content/research role can see; the operational datasets
// carry PII and stay manager/admin.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getUserRole, isManagerOrAdmin } from '../auth.js';
import { navigate } from '../router.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { exportToCSV } from '../utils/formatters.js';
import { measureLabel, leverLabel, giLabel } from '../utils/catalog.js';
import { valueLabel } from '../components/analyticsFilters.js';

const DATA_ROOM_ROLES = ['admin', 'manager', 'content'];

// ---- supabase-js silently caps every select at 1000 rows ----
// Loop .range() pages until a short page. `makeQuery` must be a
// factory returning a FRESH builder each call, with a stable
// .order() so pages never overlap.
const PAGE = 1000;
async function fetchAll(makeQuery) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// ---- cell helpers (exportToCSV drops falsy values. 0 and false
// must survive, so every column goes through an accessor) ----
const v = (x) => (x === null || x === undefined ? '' : x);
const b = (x) => (x === true ? 'true' : x === false ? 'false' : '');
const d = (x) => (x ? String(x).slice(0, 10) : '');
const istDate = (ts) => (ts ? new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : '');

// ============================================================
// Cohort filter: pick a state, a city, a stage, a cancer type, and every
// download on the page narrows to those patients. The place names are
// normalised exactly the way pf_place() does it on the database side
// ("west bengal", "West  Bengal" → "West Bengal"), so the list you choose
// from here reads the same as the analytics cohort filter.
// ============================================================
const F = { state: '', city: '', stage: '', cancer: '' };
let roster = [];   // one light row per patient, the filter's whole universe

const place = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? s.replace(/(^|[^a-z])([a-z])/g, (_, a, c) => a + c.toUpperCase()) : '';
};

const FACETS = [
  { key: 'state',  label: 'State',       of: (p) => place(p.state) },
  { key: 'city',   label: 'City',        of: (p) => place(p.city) },
  { key: 'stage',  label: 'Cancer stage', of: (p) => p.cancer_stage || 'unknown', lbl: (x) => valueLabel('stage', x) },
  { key: 'cancer', label: 'Cancer type',  of: (p) => p.gi_subtype || '',          lbl: (x) => valueLabel('cancer', x) },
];

const matchesFilter = (p, f) => FACETS.every((x) => !f[x.key] || x.of(p) === f[x.key]);

const isFiltered = () => FACETS.some((x) => F[x.key]);

// Every patient id the current filter allows: null when nothing is filtered,
// which the builders read as "no narrowing, ship the whole dataset".
function allowedIds() {
  if (!isFiltered()) return null;
  return new Set(roster.filter((p) => matchesFilter(p, F)).map((p) => p.id));
}

// Options for one dropdown, counted with that dropdown's OWN filter removed:
// otherwise picking Maharashtra leaves Maharashtra as the only state you can
// ever choose again.
function facetOptions(facet) {
  const others = { ...F, [facet.key]: '' };
  const counts = new Map();
  roster.filter((p) => matchesFilter(p, others)).forEach((p) => {
    const val = facet.of(p);
    if (!val) return;
    counts.set(val, (counts.get(val) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

// The filter, folded into the file name, so three downloads for three states
// do not all land in the folder as the same file.
function fileSuffix() {
  const bits = FACETS.filter((x) => F[x.key]).map((x) => String(F[x.key]).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return bits.length ? '_' + bits.join('_') : '';
}

function filterSentence() {
  const bits = FACETS.filter((x) => F[x.key]).map((x) => `${x.label}: ${x.lbl ? x.lbl(F[x.key]) : F[x.key]}`);
  return bits.join(' · ');
}

// ---- shared column sets ----
const PATIENT_RESEARCH_COLS = [
  { label: 'Patient code',     accessor: (r) => v(r.patient_code) },
  { label: 'Age',              accessor: (r) => v(r.age) },
  { label: 'Gender',           accessor: (r) => v(r.gender) },
  { label: 'Status',           accessor: (r) => v(r.patient_status) },
  { label: 'GI subtype',       accessor: (r) => v(r.gi_subtype) },
  { label: 'Cancer stage',     accessor: (r) => v(r.cancer_stage) },
  { label: 'TNM stage',        accessor: (r) => v(r.tnm_stage) },
  { label: 'Biomarkers',       accessor: (r) => v(r.biomarkers) },
  { label: 'ECOG',             accessor: (r) => v(r.ecog_status) },
  { label: 'Trajectory',       accessor: (r) => v(r.trajectory) },
  { label: 'Stoma',            accessor: (r) => v(r.stoma_type) },
  { label: 'Current treatment / drugs', accessor: (r) => v(r.current_treatment) },
  { label: 'City',             accessor: (r) => v(r.city) },
  { label: 'State',            accessor: (r) => v(r.state) },
  { label: 'Insurance',        accessor: (r) => v(r.insurance_status) },
  { label: 'Economic status',  accessor: (r) => v(r.economic_status) },
  { label: 'Consent given',    accessor: (r) => b(r.consent_given) },
  { label: 'Diagnosis date',   accessor: (r) => d(r.diagnosis_date) },
  { label: 'Registered on',    accessor: (r) => istDate(r.created_at) },
];

const PATIENT_RESEARCH_SELECT =
  'patient_code, age, gender, patient_status, gi_subtype, cancer_stage, trajectory, ' +
  'tnm_stage, biomarkers, ecog_status, stoma_type, current_treatment, ' +
  'city, state, insurance_status, economic_status, consent_given, diagnosis_date, created_at';

// Per-patient call activity, including how long we actually spent on the
// phone. Duration only counts on connected calls. A 0-minute "no answer"
// would otherwise drag every average toward zero.
async function fetchCallStatsMap(sb) {
  const logs = await fetchAll(() => sb.from('call_logs')
    .select('patient_id, dial_status, call_duration_mins, call_date')
    .order('id'));
  const map = {};
  logs.forEach((l) => {
    const s = map[l.patient_id] || (map[l.patient_id] = { calls: 0, connected: 0, mins: 0, last: null });
    s.calls += 1;
    if (l.dial_status === 'connected') {
      s.connected += 1;
      s.mins += Number(l.call_duration_mins) || 0;
    }
    if (l.call_date && (!s.last || l.call_date > s.last)) s.last = l.call_date;
  });
  return map;
}

// Shared by the de-identified and the full patient exports: these are
// aggregates, so they carry no personal data the research view doesn't
// already have.
function callActivityCols(stats) {
  const s = (r) => stats[r.id] || { calls: 0, connected: 0, mins: 0, last: null };
  return [
    { label: 'Calls made',       accessor: (r) => s(r).calls },
    { label: 'Calls connected',  accessor: (r) => s(r).connected },
    { label: 'Talk time (mins)', accessor: (r) => Math.round(s(r).mins) },
    { label: 'Avg mins / connected call', accessor: (r) => {
      const x = s(r);
      return x.connected ? Math.round((x.mins / x.connected) * 10) / 10 : '';
    } },
    { label: 'Last call', accessor: (r) => istDate(s(r).last) },
  ];
}

// The patient's next follow-up lives on call_logs (what
// build_daily_assignments reads), latest one per patient.
async function fetchFollowupMap(sb) {
  const logs = await fetchAll(() => sb.from('call_logs')
    .select('patient_id, next_followup_date')
    .not('next_followup_date', 'is', null)
    .order('id'));
  const map = {};
  logs.forEach((l) => {
    if (!map[l.patient_id] || l.next_followup_date > map[l.patient_id]) map[l.patient_id] = l.next_followup_date;
  });
  return map;
}

// ---- the datasets, one card each ----
// research: true → de-identified, visible to the content role too.
function datasetDefs() {
  const managerish = isManagerOrAdmin();

  const defs = [
    {
      key: 'patients_research', research: true, ico: 'users', pid: (r) => r.id,
      name: 'Patients (research view)',
      desc: 'One row per patient: demographics, diagnosis, geography, insurance and consent, plus how many times we called and how long we talked. Patient codes only: no names, phones or caregiver identity.',
      file: 'jcf_patients_research_raw',
      countFrom: 'patients',
      build: async (sb) => {
        // id is selected for the call-stats join only; it is never a column.
        const [rows, stats] = await Promise.all([
          fetchAll(() => sb.from('patients').select('id, ' + PATIENT_RESEARCH_SELECT).order('patient_code')),
          fetchCallStatsMap(sb),
        ]);
        return { rows, columns: [...PATIENT_RESEARCH_COLS, ...callActivityCols(stats)] };
      },
    },
    {
      key: 'wellbeing', research: true, ico: 'activity', pid: (r) => r.patient_id,
      name: 'Wellbeing assessments',
      desc: 'Every scored measure ever recorded (QoL, PHQ-4, financial toxicity, MUST, caregiver burden) with the patient\'s code, age and gender for cohorting.',
      file: 'jcf_wellbeing_raw',
      countFrom: 'patient_assessments',
      build: async (sb) => {
        const select = 'patient_id, measure, score, recorded_at, patient:patients(patient_code, age, gender)'
          + (managerish ? ', recorder:profiles!patient_assessments_recorded_by_fkey(full_name)' : '');
        const rows = await fetchAll(() => sb.from('patient_assessments').select(select).order('recorded_at').order('id'));
        const columns = [
          { label: 'Patient code',  accessor: (r) => v(r.patient?.patient_code) },
          { label: 'Age',           accessor: (r) => v(r.patient?.age) },
          { label: 'Gender',        accessor: (r) => v(r.patient?.gender) },
          { label: 'Measure',       accessor: (r) => v(r.measure) },
          { label: 'Measure label', accessor: (r) => measureLabel(r.measure) },
          { label: 'Score',         accessor: (r) => v(r.score) },
          { label: 'Recorded on (IST)', accessor: (r) => istDate(r.recorded_at) },
          ...(managerish ? [{ label: 'Recorded by', accessor: (r) => v(r.recorder?.full_name) }] : []),
        ];
        return { rows, columns };
      },
    },
    {
      key: 'levers', research: true, ico: 'handHeart', pid: (r) => r.patient_id,
      name: 'Support levers',
      desc: 'Every concrete act of support (financial aid, nutrition plans, second opinions, sessions) with amounts, session counts and outcomes.',
      file: 'jcf_support_levers_raw',
      countFrom: 'patient_services',
      build: async (sb) => {
        // detail is free text. Don't even fetch it for non-managers.
        const rows = await fetchAll(() => sb.from('patient_services')
          .select('patient_id, lever, done, amount, sessions, outcome, recorded_at' + (managerish ? ', detail' : '') + ', patient:patients(patient_code)')
          .order('recorded_at').order('id'));
        const columns = [
          { label: 'Patient code', accessor: (r) => v(r.patient?.patient_code) },
          { label: 'Lever',        accessor: (r) => v(r.lever) },
          { label: 'Lever label',  accessor: (r) => leverLabel(r.lever) },
          { label: 'Delivered',    accessor: (r) => b(r.done) },
          { label: 'Amount (₹)',   accessor: (r) => v(r.amount) },
          { label: 'Sessions',     accessor: (r) => v(r.sessions) },
          { label: 'Outcome',      accessor: (r) => v(r.outcome) },
          // detail is free text (an intern's own words), managers only.
          ...(managerish ? [{ label: 'Detail', accessor: (r) => v(r.detail) }] : []),
          { label: 'Recorded on', accessor: (r) => istDate(r.recorded_at) },
        ];
        return { rows, columns };
      },
    },
  ];

  if (!managerish) return defs;

  defs.splice(1, 0, {
    key: 'patients_full', research: false, ico: 'users', pid: (r) => r.id,
    name: 'Patients (full registry)',
    desc: 'The research columns PLUS names, phones, caregiver details, hospital, doctor, treatment, payment and the assigned mentor. Handle with care.',
    file: 'jcf_patients_registry_raw',
    countFrom: 'patients',
    build: async (sb) => {
      const [rows, followups, stats] = await Promise.all([
        fetchAll(() => sb.from('patients')
          .select('id, ' + PATIENT_RESEARCH_SELECT + ', full_name, phone_masked, phone_full, email, ' +
            'caregiver_name, caregiver_relationship, caregiver_gender, caregiver_phone_full, ' +
            'treating_hospital, treating_doctor, payment_method, is_active, do_not_call, ' +
            'mentor:profiles!patients_assigned_to_fkey(full_name)')
          .order('patient_code')),
        fetchFollowupMap(sb),
        fetchCallStatsMap(sb),
      ]);
      const columns = [
        ...PATIENT_RESEARCH_COLS,
        ...callActivityCols(stats),
        { label: 'Full name',            accessor: (r) => v(r.full_name) },
        // text: true keeps Excel from opening a 10-digit number in scientific
        // notation and swallowing any leading zero.
        { label: 'Phone (masked)',       accessor: (r) => v(r.phone_masked), text: true },
        { label: 'Phone (full)',         accessor: (r) => v(r.phone_full), text: true },
        { label: 'Email',                accessor: (r) => v(r.email) },
        { label: 'Caregiver',            accessor: (r) => v(r.caregiver_name) },
        { label: 'Caregiver relation',   accessor: (r) => v(r.caregiver_relationship) },
        { label: 'Caregiver gender',     accessor: (r) => v(r.caregiver_gender) },
        { label: 'Caregiver phone',      accessor: (r) => v(r.caregiver_phone_full), text: true },
        { label: 'Hospital',             accessor: (r) => v(r.treating_hospital) },
        { label: 'Treating doctor',      accessor: (r) => v(r.treating_doctor) },
        { label: 'Payment method',       accessor: (r) => v(r.payment_method) },
        { label: 'Assigned mentor',      accessor: (r) => v(r.mentor?.full_name) },
        { label: 'Next follow-up',       accessor: (r) => d(followups[r.id]) },
        { label: 'Active',               accessor: (r) => b(r.is_active) },
        { label: 'Do not call',          accessor: (r) => b(r.do_not_call) },
      ];
      return { rows, columns };
    },
  });

  defs.push(
    {
      key: 'clinical', research: false, ico: 'activity', pid: (r) => r.id,
      name: 'Clinical sheet (treatment and staging)',
      desc: 'The medical picture, one row per patient: name, cancer type and stage, TNM, biomarkers, ECOG, the drugs/regimen they are currently on, hospital and treating doctor. Use the filters above to pull one state or one city.',
      file: 'jcf_clinical_sheet',
      countFrom: 'patients',
      build: async (sb) => {
        const [rows, stats] = await Promise.all([
          fetchAll(() => sb.from('patients')
            .select('id, patient_code, full_name, age, gender, phone_full, city, state, ' +
              'cancer_type, gi_subtype, cancer_stage, tnm_stage, biomarkers, ecog_status, trajectory, stoma_type, ' +
              'current_treatment, diagnosis_date, treating_hospital, treating_doctor, referring_doctor, ' +
              'insurance_status, payment_method, patient_status, primary_language, ' +
              'mentor:profiles!patients_assigned_to_fkey(full_name)')
            .order('state').order('city').order('full_name')),
          fetchCallStatsMap(sb),
        ]);
        const columns = [
          { label: 'Patient code',      accessor: (r) => v(r.patient_code) },
          { label: 'Name',              accessor: (r) => v(r.full_name) },
          { label: 'Age',               accessor: (r) => v(r.age) },
          { label: 'Gender',            accessor: (r) => v(r.gender) },
          { label: 'Phone',             accessor: (r) => v(r.phone_full), text: true },
          { label: 'City',              accessor: (r) => v(r.city) },
          { label: 'State',             accessor: (r) => v(r.state) },
          { label: 'Cancer type',       accessor: (r) => giLabel(r.gi_subtype) || v(r.cancer_type) },
          { label: 'Stage',             accessor: (r) => (r.cancer_stage && r.cancer_stage !== 'unknown' ? valueLabel('stage', r.cancer_stage) : '') },
          { label: 'TNM stage',         accessor: (r) => v(r.tnm_stage) },
          { label: 'Biomarkers',        accessor: (r) => v(r.biomarkers) },
          { label: 'ECOG',              accessor: (r) => v(r.ecog_status) },
          { label: 'Disease path',      accessor: (r) => v(r.trajectory) },
          { label: 'Stoma',             accessor: (r) => v(r.stoma_type) },
          // The registry has one treatment field and it is free text. Mentors
          // type the regimen into it ("FOLFOX cycle 4", "Tab. Capecitabine
          // 1500mg BD"), so this column IS the drugs/medication column.
          { label: 'Current treatment / drugs', accessor: (r) => v(r.current_treatment) },
          { label: 'Diagnosed on',      accessor: (r) => d(r.diagnosis_date) },
          { label: 'Treating hospital', accessor: (r) => v(r.treating_hospital) },
          { label: 'Treating doctor',   accessor: (r) => v(r.treating_doctor) },
          { label: 'Referring doctor',  accessor: (r) => v(r.referring_doctor) },
          { label: 'Insurance',         accessor: (r) => v(r.insurance_status) },
          { label: 'Payment method',    accessor: (r) => v(r.payment_method) },
          { label: 'Lifecycle',         accessor: (r) => v(r.patient_status) },
          { label: 'Language',          accessor: (r) => v(r.primary_language) },
          { label: 'Caregiver mentor',  accessor: (r) => v(r.mentor?.full_name) },
          { label: 'Last call',         accessor: (r) => istDate((stats[r.id] || {}).last) },
        ];
        return { rows, columns };
      },
    },
    {
      key: 'calls', research: false, ico: 'phone', pid: (r) => r.patient_id,
      name: 'Call logs',
      desc: 'Every call ever made: who called whom, dial status, receptiveness, duration, the mentor\'s notes and the promised next follow-up.',
      file: 'jcf_call_logs_raw',
      countFrom: 'call_logs',
      build: async (sb) => {
        const rows = await fetchAll(() => sb.from('call_logs')
          .select('patient_id, call_date, dial_status, receptiveness_bucket, call_duration_mins, caller_notes, next_followup_date, ' +
            'patient:patients(patient_code, full_name), caller:profiles!call_logs_caller_id_fkey(full_name)')
          .order('call_date').order('id'));
        const columns = [
          { label: 'Patient code',    accessor: (r) => v(r.patient?.patient_code) },
          { label: 'Patient',         accessor: (r) => v(r.patient?.full_name) },
          { label: 'Caller',          accessor: (r) => v(r.caller?.full_name) },
          { label: 'Call date (IST)', accessor: (r) => istDate(r.call_date) },
          { label: 'Dial status',     accessor: (r) => v(r.dial_status) },
          { label: 'Receptiveness',   accessor: (r) => v(r.receptiveness_bucket) },
          { label: 'Duration (mins)', accessor: (r) => v(r.call_duration_mins) },
          { label: 'Notes',           accessor: (r) => v(r.caller_notes) },
          { label: 'Next follow-up',  accessor: (r) => d(r.next_followup_date) },
        ];
        return { rows, columns };
      },
    },
    {
      key: 'sessions', research: false, ico: 'calendar', pid: (r) => r.patient_id,
      name: '1:1 sessions',
      desc: 'The specialist-session pipeline: wellbeing, nutrition and caregiver 1:1s from invite to held, with who invited, who held it, and the notes.',
      file: 'jcf_sessions_raw',
      countFrom: 'care_sessions',
      build: async (sb) => {
        const rows = await fetchAll(() => sb.from('care_sessions')
          .select('patient_id, kind, status, invited_at, agreed_at, scheduled_at, held_at, duration_mins, session_notes, created_at, ' +
            'patient:patients(patient_code, full_name), ' +
            'inviter:profiles!care_sessions_invited_by_fkey(full_name), ' +
            'assignee:profiles!care_sessions_assigned_to_fkey(full_name)')
          .order('created_at').order('id'));
        const columns = [
          { label: 'Patient code',    accessor: (r) => v(r.patient?.patient_code) },
          { label: 'Patient',         accessor: (r) => v(r.patient?.full_name) },
          { label: 'Kind',            accessor: (r) => v(r.kind) },
          { label: 'Status',          accessor: (r) => v(r.status) },
          { label: 'Invited by',      accessor: (r) => v(r.inviter?.full_name) },
          { label: 'Assigned to',     accessor: (r) => v(r.assignee?.full_name) },
          { label: 'Invited on',      accessor: (r) => istDate(r.invited_at) },
          { label: 'Agreed on',       accessor: (r) => istDate(r.agreed_at) },
          { label: 'Scheduled for',   accessor: (r) => istDate(r.scheduled_at) },
          { label: 'Held on',         accessor: (r) => istDate(r.held_at) },
          { label: 'Duration (mins)', accessor: (r) => v(r.duration_mins) },
          { label: 'Session notes',   accessor: (r) => v(r.session_notes) },
          { label: 'Created on',      accessor: (r) => istDate(r.created_at) },
        ];
        return { rows, columns };
      },
    },
    {
      key: 'concerns', research: false, ico: 'alertTriangle', pid: (r) => r.patient_id,
      name: 'Concerns',
      desc: 'Every clinical escalation ever raised: reason, severity, who flagged it, and how (or whether) it was resolved.',
      file: 'jcf_concerns_raw',
      countFrom: 'patient_concerns',
      build: async (sb) => {
        const rows = await fetchAll(() => sb.from('patient_concerns')
          .select('patient_id, source, reason, severity, note, status, created_at, acknowledged_at, resolved_at, resolution_note, ' +
            'patient:patients(patient_code, full_name), ' +
            'raiser:profiles!patient_concerns_raised_by_fkey(full_name), ' +
            'resolver:profiles!patient_concerns_resolved_by_fkey(full_name)')
          .order('created_at').order('id'));
        const columns = [
          { label: 'Patient code',    accessor: (r) => v(r.patient?.patient_code) },
          { label: 'Patient',         accessor: (r) => v(r.patient?.full_name) },
          { label: 'Source',          accessor: (r) => v(r.source) },
          { label: 'Reason',          accessor: (r) => v(r.reason) },
          { label: 'Severity',        accessor: (r) => v(r.severity) },
          { label: 'Note',            accessor: (r) => v(r.note) },
          { label: 'Status',          accessor: (r) => v(r.status) },
          { label: 'Raised by',       accessor: (r) => v(r.raiser?.full_name) },
          { label: 'Raised on',       accessor: (r) => istDate(r.created_at) },
          { label: 'Acknowledged on', accessor: (r) => istDate(r.acknowledged_at) },
          { label: 'Resolved on',     accessor: (r) => istDate(r.resolved_at) },
          { label: 'Resolved by',     accessor: (r) => v(r.resolver?.full_name) },
          { label: 'Resolution note', accessor: (r) => v(r.resolution_note) },
        ];
        return { rows, columns };
      },
    },
  );

  return defs;
}

// Build a dataset, then narrow it to the filtered cohort. A dataset with no
// `pid` (there are none today) is left whole rather than silently emptied.
async function buildDataset(ds, sb) {
  const { rows, columns } = await ds.build(sb);
  const ids = allowedIds();
  if (!ids || !ds.pid) return { rows, columns };
  return { rows: rows.filter((r) => ids.has(ds.pid(r))), columns };
}

// ---- page ----
export async function renderExports(container) {
  const role = getUserRole();
  if (!DATA_ROOM_ROLES.includes(role)) {
    showToast('The Data room is for managers and the research team', 'warning');
    navigate('dashboard');
    return;
  }

  const defs = datasetDefs();
  const research = defs.filter((x) => x.research);
  const operational = defs.filter((x) => !x.research);

  const card = (ds) => `
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="display:flex;align-items:center;gap:9px;min-width:0">
          <span style="width:18px;height:18px;display:inline-flex;flex:none;color:var(--ink-3)">${icon(ds.ico)}</span>
          <strong style="font:var(--t-body-strong)">${ds.name}</strong>
        </div>
        <span class="badge ${ds.research ? 'badge-ok' : 'badge-warn'}" style="flex:none">${ds.research ? 'De-identified' : 'Personal data'}</span>
      </div>
      <p style="font:var(--t-xs);color:var(--ink-2);margin:0;flex:1">${ds.desc}</p>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span class="tnum" id="dr-count-${ds.key}" style="font:var(--t-xs);color:var(--ink-3)">Counting…</span>
        <button class="btn btn-primary btn-sm" data-ds="${ds.key}">${icon('download')}Download CSV</button>
      </div>
    </div>`;

  const section = (title, sub, list) => list.length ? `
    <div style="margin-bottom:var(--s6)">
      <h3 style="margin:0 0 2px">${title}</h3>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 var(--s4)">${sub}</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--s4)">
        ${list.map(card).join('')}
      </div>
    </div>` : '';

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Data room</h1>
        <p class="header-subtitle" style="margin:4px 0 0">The raw data, whenever you need it: every dataset, full history, one click. Put your own filters on in Excel; no more ad-hoc files over WhatsApp.</p>
      </div>
      <button class="btn btn-primary" id="dr-all" title="One click: every dataset you can access, each as its own CSV">${icon('download')}Download everything</button>
    </div>

    <div class="card" style="padding:13px 16px;margin-bottom:var(--s5);display:flex;align-items:center;gap:11px;border-left:4px solid var(--warn);background:var(--warn-soft)">
      <span style="width:18px;height:18px;display:inline-flex;flex:none;color:var(--warn)">${icon('shieldCheck')}</span>
      <div style="font:var(--t-xs);color:var(--ink-2)"><strong>DPDPA note.</strong> Exports contain personal data. Handle every downloaded file under the same confidentiality as the portal itself. Research-grade files are de-identified: patient codes only, never names or phones.</div>
    </div>

    <div class="card" id="dr-filter" style="margin-bottom:var(--s5)"></div>

    ${section('Research-grade (de-identified)', 'Safe to share with the research team: no names, no phone numbers.', research)}
    ${section('Operational (contains personal data)', 'Names, phones and free-text notes: for internal coordination only.', operational)}
  `;

  const sb = getSupabase();

  // ---- the filter bar ----
  const filterEl = container.querySelector('#dr-filter');

  function renderFilter() {
    const matched = isFiltered() ? roster.filter((p) => matchesFilter(p, F)).length : roster.length;
    const selects = FACETS.map((facet) => {
      const opts = facetOptions(facet);
      const chosen = F[facet.key];
      // A value can go missing from the list once another filter narrows the
      // cohort past it; keep it selectable so the dropdown never lies about
      // what is actually filtering the downloads.
      const has = opts.some(([val]) => val === chosen);
      return `
        <label style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 180px">
          <span style="font:var(--t-xs);color:var(--ink-3)">${facet.label}</span>
          <select class="form-select" data-facet="${facet.key}">
            <option value="">All (${opts.length})</option>
            ${!has && chosen ? `<option value="${chosen}" selected>${facet.lbl ? facet.lbl(chosen) : chosen}</option>` : ''}
            ${opts.map(([val, n]) =>
              `<option value="${String(val).replace(/"/g, '&quot;')}" ${val === chosen ? 'selected' : ''}>${facet.lbl ? facet.lbl(val) : val} (${n})</option>`).join('')}
          </select>
        </label>`;
    }).join('');

    filterEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
        <span style="width:17px;height:17px;display:inline-flex;flex:none;color:var(--ink-3)">${icon('filter')}</span>
        <strong style="font:var(--t-body-strong)">Filter the download</strong>
        <span style="font:var(--t-xs);color:var(--ink-3)">Pick a state or a city and every file below comes down for just those patients.</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:var(--s3);align-items:flex-end">
        ${selects}
        <button class="btn btn-ghost btn-sm" id="dr-clear" ${isFiltered() ? '' : 'disabled'} style="flex:none">Clear</button>
      </div>
      <div style="margin-top:10px;font:var(--t-xs);color:${isFiltered() ? 'var(--gold)' : 'var(--ink-3)'}">
        ${roster.length === 0 ? 'Reading the registry…'
          : isFiltered()
            ? `<strong>${matched.toLocaleString('en-IN')}</strong> of ${roster.length.toLocaleString('en-IN')} patients match: ${filterSentence()}. Every download on this page is cut to these patients, including the call, session and concern files.`
            : `No filter. Every file covers all ${roster.length.toLocaleString('en-IN')} patients on file.`}
      </div>`;

    filterEl.querySelectorAll('[data-facet]').forEach((sel) => sel.addEventListener('change', () => {
      F[sel.dataset.facet] = sel.value;
      // Picking a state must not leave a city from a different state applied.
      if (sel.dataset.facet === 'state' && F.city) {
        const stillThere = roster.some((p) => matchesFilter(p, F));
        if (!stillThere) F.city = '';
      }
      renderFilter();
    }));
    filterEl.querySelector('#dr-clear')?.addEventListener('click', () => {
      FACETS.forEach((x) => { F[x.key] = ''; });
      renderFilter();
    });
  }

  roster = [];
  renderFilter();
  fetchAll(() => sb.from('patients').select('id, state, city, cancer_stage, gi_subtype').order('id'))
    .then((rows) => { roster = rows; renderFilter(); })
    .catch((e) => { console.error('Filter roster failed:', e); filterEl.innerHTML =
      '<div style="font:var(--t-xs);color:var(--ink-3)">Filters unavailable. Downloads will cover every patient.</div>'; });

  // Live row counts, loaded after render: head-only, no data pulled.
  defs.forEach(async (ds) => {
    const el = container.querySelector('#dr-count-' + ds.key);
    try {
      const { count, error } = await sb.from(ds.countFrom).select('*', { count: 'exact', head: true });
      if (error) throw error;
      if (el) el.textContent = (count ?? 0).toLocaleString('en-IN') + ' rows';
    } catch { if (el) el.textContent = 'count unavailable'; }
  });

  // "Download everything": every dataset the role allows, one after the
  // other (each lands as its own CSV), with live progress on the button.
  const allBtn = container.querySelector('#dr-all');
  allBtn?.addEventListener('click', async () => {
    const label = allBtn.innerHTML;
    allBtn.disabled = true;
    let ok = 0, failed = [];
    for (let i = 0; i < defs.length; i++) {
      const ds = defs[i];
      allBtn.textContent = `Building ${i + 1} of ${defs.length} · ${ds.name}…`;
      try {
        const { rows, columns } = await buildDataset(ds, sb);
        if (rows.length) { exportToCSV(rows, ds.file + fileSuffix(), columns); ok++; }
      } catch (e) { failed.push(ds.name); console.error('Export failed:', ds.key, e); }
    }
    allBtn.disabled = false;
    allBtn.innerHTML = label;
    if (failed.length) showToast(`${ok} files downloaded · failed: ${failed.join(', ')}`, 'warning');
    else showToast(`All ${ok} datasets downloaded. Check your Downloads folder`, 'success');
  });

  // Download buttons: spinner while the pages are fetched + built.
  container.querySelectorAll('[data-ds]').forEach((btn) => btn.addEventListener('click', async () => {
    const ds = defs.find((x) => x.key === btn.dataset.ds);
    if (!ds) return;
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const { rows, columns } = await buildDataset(ds, sb);
      if (!rows.length) {
        showToast(isFiltered() ? 'No rows for this filter. Try a wider one' : 'No rows in this dataset yet', 'info');
        return;
      }
      exportToCSV(rows, ds.file + fileSuffix(), columns);
      showToast(`${ds.name} · ${rows.length.toLocaleString('en-IN')} rows downloaded${isFiltered() ? ` (${filterSentence()})` : ''}`, 'success');
    } catch (e) {
      showToast('Export failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }));
}
