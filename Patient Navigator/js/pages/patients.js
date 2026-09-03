// ============================================================
// Patient Navigator: Patients (v7 care depth)
// List: status buckets + GI subtype filters. Detail: the full
// WHO → ACTION → IMPACT record: clinical profile, support-lever
// ledger, wellbeing scores over time, bereavement. RLS scopes
// all queries per role; no client-side owner filtering needed.
// ============================================================

import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, isManagerOrAdmin, getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { openCallForm } from '../components/callForm.js';
import { openWhatsappShare, recipientsFromPatient } from '../components/whatsappShare.js';
import { openAssessmentFlow } from '../components/assessmentFlow.js';
import { mountBeforeYouCall } from '../components/beforeYouCall.js';
import { formatDate, formatRelativeTime, capitalize, getDialStatusBadge, exportToCSV, renderSkeleton } from '../utils/formatters.js';
import { sanitize } from '../utils/validators.js';
import { navigate, goBack } from '../router.js';
import { icon } from '../components/icons.js';
import {
  PATIENT_STATUSES, statusBadge, GI_SUBTYPES, giLabel, TRAJECTORIES, STOMA_TYPES,
  HEALTH_LITERACY, ECOG, SCHOOL_RETENTION, LEVER_GROUPS, OUTCOME_FLAGS,
  MEASURES, BEREAVEMENT_MEASURES, CONDITIONS, vulnerabilityBadge, INSTRUMENTS, dataGaps,
  sessionKind, sessionStatus, leverLabel,
} from '../utils/catalog.js';

const PAGE_SIZE = 25;
let currentPage = 1;
let statusFilter = '';

export async function renderPatients(container, params) {
  if (params?.id) { await renderPatientDetail(container, params.id); return; }
  renderPatientList(container);
}

// ============================================================
// LIST
// ============================================================
async function renderPatientList(container) {
  const canExport = isManagerOrAdmin();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Patients</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Everyone in the care program</p>
      </div>
      <div class="flex gap-2" style="display:flex;gap:9px">
        ${canExport ? `<button class="btn btn-secondary" id="export-patients-btn">${icon('download')}Export CSV</button>` : ''}
        <button class="btn btn-primary" id="add-patient-btn">${icon('plus')}Register patient</button>
      </div>
    </div>

    <div class="chip-row" id="status-chips" style="margin-bottom:var(--s4)">
      <button class="fchip ${statusFilter === '' ? 'on' : ''}" data-status="">All <span class="n" id="cnt-all"></span></button>
      ${PATIENT_STATUSES.map(s => `<button class="fchip ${statusFilter === s.key ? 'on' : ''}" data-status="${s.key}">${s.label} <span class="n" id="cnt-${s.key}"></span></button>`).join('')}
    </div>

    <div class="table-container">
      <div class="table-toolbar">
        <div class="table-search">
          ${icon('search')}
          <input class="form-input" id="patient-search" placeholder="Search name, ID, city, cancer type…" />
        </div>
        <div class="table-filters">
          <select class="form-select" id="filter-sort" style="width:auto;min-width:150px"
                  title="Who needs reaching first: open concern, then days overdue, then household need. Ties go to the thinnest record.">
            <option value="priority">Sort: who needs us</option>
            <option value="newest">Sort: newest first</option>
          </select>
          <select class="form-select" id="filter-gi" style="width:auto;min-width:170px">
            <option value="">All GI subtypes</option>
            ${GI_SUBTYPES.map(g => `<option value="${g.key}">${g.label}</option>`).join('')}
            <option value="__none">Unclassified</option>
          </select>
        </div>
      </div>
      <div id="patients-table-body">${renderSkeleton(8)}</div>
      <div class="table-pagination" id="patients-pagination"></div>
    </div>
  `;

  let searchTimeout;
  container.querySelector('#patient-search')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { currentPage = 1; loadPatients(); }, 300);
  });
  container.querySelector('#filter-gi')?.addEventListener('change', () => { currentPage = 1; loadPatients(); });
  container.querySelector('#filter-sort')?.addEventListener('change', (e) => {
    sortMode = e.target.value; currentPage = 1; loadPatients();
  });
  container.querySelector('#add-patient-btn')?.addEventListener('click', () => showPatientForm(null, loadPatients));
  container.querySelectorAll('#status-chips .fchip').forEach(chip => {
    chip.addEventListener('click', () => {
      statusFilter = chip.dataset.status;
      container.querySelectorAll('#status-chips .fchip').forEach(c => c.classList.toggle('on', c === chip));
      currentPage = 1; loadPatients();
    });
  });

  container.querySelector('#export-patients-btn')?.addEventListener('click', async () => {
    const sb = getSupabase();
    showToast('Preparing CSV export…', 'info');
    try {
      const { data, error } = await sb.from('patients').select('*').eq('is_active', true).order('created_at', { ascending: false });
      if (error) throw error;
      exportToCSV(data, 'patients_export', [
        { label: 'Patient ID', key: 'patient_code' }, { label: 'Name', key: 'full_name' },
        { label: 'Status', key: 'patient_status' }, { label: 'Age', key: 'age' }, { label: 'Sex', key: 'gender' },
        // text: true. A bare 10-digit number opens in Excel as 6.2E+09.
        { label: 'Phone', key: 'phone_full', text: true }, { label: 'Email', key: 'email' },
        { label: 'State', key: 'state' }, { label: 'City', key: 'city' },
        { label: 'Cancer Type', key: 'cancer_type' }, { label: 'GI Subtype', accessor: r => giLabel(r.gi_subtype) || '' },
        { label: 'Stage', key: 'cancer_stage' }, { label: 'TNM', key: 'tnm_stage' }, { label: 'Biomarkers', key: 'biomarkers' },
        { label: 'ECOG', key: 'ecog_status' }, { label: 'Trajectory', key: 'trajectory' }, { label: 'Stoma', key: 'stoma_type' },
        { label: 'Diagnosed', key: 'diagnosis_date' }, { label: 'Hospital', key: 'treating_hospital' },
        { label: 'Treating Doctor', key: 'treating_doctor' }, { label: 'Referring Doctor', key: 'referring_doctor' },
        { label: 'Treatment', key: 'current_treatment' }, { label: 'Insurance', key: 'insurance_status' },
        { label: 'Economic', key: 'economic_status' }, { label: 'Payment', key: 'payment_method' },
        { label: 'Language', key: 'primary_language' }, { label: 'Health Literacy', key: 'health_literacy' },
        { label: 'Employment at Dx', key: 'employment_at_diagnosis' }, { label: 'Dependents', key: 'dependents_count' },
        { label: 'Distance (km)', key: 'distance_to_treatment_km' }, { label: 'Vulnerability', key: 'vulnerability_score' },
        { label: 'Caregiver', key: 'caregiver_name' }, { label: 'Caregiver Rel.', key: 'caregiver_relationship' },
        { label: 'Caregiver Phone', key: 'caregiver_phone_full', text: true },
        { label: 'Trial Aware', accessor: r => r.clinical_trial_aware ? 'Yes' : 'No' },
        { label: 'Consent', accessor: r => r.consent_given ? 'Yes' : 'No' },
        { label: 'Date of Death', key: 'date_of_death' }, { label: 'Registered', key: 'created_at' },
      ]);
      showToast(`Exported ${data.length} patients`, 'success');
    } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
  });

  // Counts after the list, not alongside it. Six `head: true` counts fired in
  // parallel with the list query used to put seven scans of `patients` on the
  // pooler at once, which is what pushed the slowest of them past the 8 s
  // statement_timeout. They are decorative, so they can wait a beat.
  await loadPatients();
  loadStatusCounts();
}

async function loadStatusCounts() {
  // RLS-scoped head counts so the chips always match what THIS user can
  // see (the get_status_mix RPC is SECURITY DEFINER and counts everyone).
  const sb = getSupabase();
  try {
    const counts = await Promise.all(PATIENT_STATUSES.map(s =>
      sb.from('patients').select('*', { count: 'exact', head: true })
        .eq('is_active', true).eq('patient_status', s.key)));
    let total = 0;
    PATIENT_STATUSES.forEach((s, i) => {
      const n = counts[i]?.count || 0;
      total += n;
      const el = document.getElementById(`cnt-${s.key}`);
      if (el) el.textContent = n || '';
    });
    const all = document.getElementById('cnt-all');
    if (all) all.textContent = total || '';
  } catch { /* counts are decorative */ }
}

// A search term goes into PostgREST's `or=(...)` filter grammar, where a comma
// ends the term and a parenthesis ends the group. Searching for "Kumar, S" or
// "Rao (Sr)" therefore produced a malformed filter rather than no results.
// Double-quoting the value makes those characters literal; inside the quotes
// only a backslash and a quote still need escaping. `*` is PostgREST's own
// wildcard, so a typed one is escaped too.
function orIlikeValue(term) {
  return '"%' + term.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\*/g, '\\*') + '%"';
}

// Every keystroke starts a query, and they do not come back in order. A slow
// early one landing after a fast later one used to repaint the table with
// results for a term the user had already moved past. Only the newest request
// is allowed to write to the DOM.
let searchSeq = 0;
let inFlight = null;

// 'priority' = who needs reaching first (the default). 'newest' = the old
// created_at order, kept because it is genuinely the right view right after a
// bulk intake, when you want to see what just landed.
let sortMode = 'priority';

// The band a patient sits in, and the one line that says why they are there.
// The reason comes from the database so the list, the card and any export all
// give the same answer.
const BAND_TONE = { urgent: 'danger', high: 'warn', watch: 'info', steady: 'neutral' };
function priorityCell(p) {
  if (!p.band) return '<span style="color:var(--ink-4)">N/A</span>';
  const known = (p.fields_known != null && p.fields_total)
    ? `${p.fields_known} of ${p.fields_total} details known` : '';
  return `<span class="badge badge-${BAND_TONE[p.band] || 'neutral'}">${capitalize(p.band)}</span>
    <div class="due-meta" style="margin-top:3px" title="${sanitize(known)}">${sanitize(p.reason || '')}</div>`;
}

async function loadPatients() {
  const sb = getSupabase();
  const search = (document.getElementById('patient-search')?.value || '').trim();
  const giFilter = document.getElementById('filter-gi')?.value || '';
  const tableBody = document.getElementById('patients-table-body');
  if (!tableBody) return;

  const seq = ++searchSeq;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  try {
    // Ordered by NEED, not by when someone was typed in. v_patient_list (sql/80)
    // scores every patient by open concern, then days overdue, then household
    // vulnerability, and breaks ties with the thinnest record first, on the
    // reasoning that a record with almost nothing on it is an unmeasured risk
    // rather than a low one. Ordering here rather than in JS matters: sorting the
    // page you already have only sorts 25 of 782 rows, which is exactly what made
    // the old list look arbitrary.
    let query = sb.from(sortMode === 'priority' ? 'v_patient_list' : 'patients')
      .select('*', { count: 'exact' })
      .eq('is_active', true)
      .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1)
      .abortSignal(controller.signal);

    query = sortMode === 'priority'
      ? query.order('priority_score', { ascending: false }).order('patient_code')
      : query.order('created_at', { ascending: false });

    if (statusFilter) query = query.eq('patient_status', statusFilter);
    if (giFilter === '__none') query = query.is('gi_subtype', null);
    else if (giFilter) query = query.eq('gi_subtype', giFilter);
    if (search) {
      const v = orIlikeValue(search);
      query = query.or(`full_name.ilike.${v},patient_code.ilike.${v},cancer_type.ilike.${v},city.ilike.${v},state.ilike.${v}`);
    }

    const { data, count, error } = await query;
    if (seq !== searchSeq) return; // a newer search already owns the table
    if (error) throw error;

    if (!data || data.length === 0) {
      tableBody.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('users')}</div><h4>No patients found</h4><p>Try a different filter, or register a new patient.</p></div>`;
      document.getElementById('patients-pagination').innerHTML = '';
      return;
    }

    tableBody.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Patient</th>${sortMode === 'priority' ? '<th>Why now</th>' : ''}<th>Age / Sex</th><th>GI subtype</th><th>Stage</th>
          <th>Status</th><th>Vulnerability</th><th>Location</th><th>Registered</th>
        </tr></thead>
        <tbody>
          ${data.map(p => `
            <tr class="row-link" data-patient-id="${p.id}" tabindex="0">
              <td><strong class="text-primary" style="color:var(--primary)">${sanitize(p.patient_code)}</strong><br><span style="font-weight:600">${sanitize(p.full_name)}</span></td>
              ${sortMode === 'priority' ? `<td>${priorityCell(p)}</td>` : ''}
              <td>${p.age || 'N/A'} · ${p.gender === 'prefer_not_to_say' ? 'N/A' : capitalize(p.gender)}</td>
              <td>${giLabel(p.gi_subtype) ? `<span class="badge badge-primary">${giLabel(p.gi_subtype)}</span>` : `<span style="color:var(--ink-4)">${sanitize(p.cancer_type || '') || 'N/A'}</span>`}</td>
              <td>${p.cancer_stage && p.cancer_stage !== 'unknown' ? `<span class="badge badge-neutral">${capitalize(p.cancer_stage)}</span>` : '<span style="color:var(--ink-4)">N/A</span>'}</td>
              <td>${statusBadge(p.patient_status)}</td>
              <td>${vulnerabilityBadge(p.vulnerability_score)}</td>
              <td>${[p.city, p.state].filter(Boolean).map(sanitize).join(', ') || 'N/A'}</td>
              <td>${formatDate(p.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    tableBody.querySelectorAll('tr[data-patient-id]').forEach(row => {
      const go = () => navigate('patients/' + row.dataset.patientId);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });

    const totalPages = Math.ceil((count || 0) / PAGE_SIZE);
    const pagination = document.getElementById('patients-pagination');
    if (pagination) {
      pagination.innerHTML = `
        <span>Showing ${(currentPage - 1) * PAGE_SIZE + 1}-${Math.min(currentPage * PAGE_SIZE, count)} of ${count}</span>
        <div class="page-buttons">
          <button class="btn btn-ghost btn-sm" ${currentPage <= 1 ? 'disabled' : ''} id="prev-page-btn">← Prev</button>
          <button class="btn btn-ghost btn-sm" ${currentPage >= totalPages ? 'disabled' : ''} id="next-page-btn">Next →</button>
        </div>
      `;
      document.getElementById('prev-page-btn')?.addEventListener('click', () => { currentPage--; loadPatients(); });
      document.getElementById('next-page-btn')?.addEventListener('click', () => { currentPage++; loadPatients(); });
    }
  } catch (err) {
    if (seq !== searchSeq || err?.name === 'AbortError') return; // superseded, not a failure
    console.error('Load patients error:', err);

    // The old handler only raised a toast and left the loading skeleton in
    // place, so the page sat there looking half-loaded and the only way out
    // was a browser refresh. Put the failure in the table with a Retry, so
    // the next attempt is one click away and the search box keeps working.
    const timedOut = /statement timeout|57014/i.test(err.message || '');
    tableBody.innerHTML = `
      <div class="empty">
        <div class="ico-wrap">${icon('alertTriangle')}</div>
        <h4>Could not load patients</h4>
        <p>${timedOut
          ? 'The search took too long to come back. Try again, or narrow it with a status or subtype filter.'
          : sanitize(err.message || 'Something went wrong.')}</p>
        <button class="btn btn-secondary btn-sm" id="patients-retry-btn">Retry</button>
      </div>`;
    const pag = document.getElementById('patients-pagination');
    if (pag) pag.innerHTML = '';
    document.getElementById('patients-retry-btn')?.addEventListener('click', () => {
      tableBody.innerHTML = renderSkeleton(8);
      loadPatients();
    });
    showToast(timedOut ? 'Search timed out, tap Retry' : 'Failed to load patients: ' + err.message, 'error');
  }
}

// ============================================================
// REGISTER / EDIT FORM: the full WHO record
// ============================================================
function opt(list, current, blank = 'N/A') {
  return `<option value="">${blank}</option>` +
    list.map(o => `<option value="${o.key}" ${String(current) === String(o.key) ? 'selected' : ''}>${o.label}</option>`).join('');
}

// Reading a document is no longer a form-filling trick. It uploads to our own
// private bucket, parses server side with the key held as an Edge Function
// secret, and gives the mentor a reviewable proposal.
//   "Read a document"      one photograph        js/pages/documents.js
//   "Read a whole folder"  whatever the family sent, PDFs and photos mixed,
//                          cut into documents first   js/pages/docBatch.js

function showPatientForm(existing = null, onSaved = null) {
  const isEdit = !!existing;
  const x = existing || {};
  const el = document.createElement('div');
  el.innerHTML = `
    <form id="patient-form" novalidate>
      <div class="fsec"><span class="fsec-ico">${icon('user')}</span><div><h4>Identity & contact</h4><div class="fsec-sub">Who they are and how to reach them</div></div></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Full name <span class="required">*</span></label>
          <input class="form-input" id="pf-name" value="${sanitize(x.full_name || '')}" required /></div>
        <div class="form-group"><label class="form-label">Age</label>
          <input class="form-input" id="pf-age" type="number" min="0" max="120" value="${x.age ?? ''}" /></div>
        <div class="form-group"><label class="form-label">Sex</label>
          <select class="form-select" id="pf-gender">
            <option value="prefer_not_to_say" ${!x.gender || x.gender === 'prefer_not_to_say' ? 'selected' : ''}>Prefer not to say</option>
            <option value="male" ${x.gender === 'male' ? 'selected' : ''}>Male</option>
            <option value="female" ${x.gender === 'female' ? 'selected' : ''}>Female</option>
            <option value="other" ${x.gender === 'other' ? 'selected' : ''}>Other</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Phone number</label>
          <input class="form-input" id="pf-phone" value="${sanitize(x.phone_full || '')}" placeholder="98765 43210" inputmode="tel" /></div>
        <div class="form-group"><label class="form-label">Email</label>
          <input class="form-input" id="pf-email" type="email" value="${sanitize(x.email || '')}" placeholder="optional" /></div>
        <div class="form-group"><label class="form-label">Primary language</label>
          <input class="form-input" id="pf-language" value="${sanitize(x.primary_language || '')}" placeholder="e.g., Hindi, Marathi" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">City</label>
          <input class="form-input" id="pf-city" value="${sanitize(x.city || '')}" /></div>
        <div class="form-group"><label class="form-label">State</label>
          <input class="form-input" id="pf-state" value="${sanitize(x.state || '')}" /></div>
      </div>

      <div class="fsec"><span class="fsec-ico">${icon('stethoscope')}</span><div><h4>Clinical profile</h4><div class="fsec-sub">Diagnosis, staging and current treatment</div></div></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">GI cancer subtype</label>
          <select class="form-select" id="pf-gi">${opt(GI_SUBTYPES, x.gi_subtype, 'Not classified')}</select></div>
        <div class="form-group"><label class="form-label">Stage</label>
          <select class="form-select" id="pf-stage">
            ${['unknown', 'stage_i', 'stage_ii', 'stage_iii', 'stage_iv', 'not_applicable'].map(s =>
              `<option value="${s}" ${(x.cancer_stage || 'unknown') === s ? 'selected' : ''}>${capitalize(s)}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">TNM stage <span class="form-hint" style="display:inline">(if known)</span></label>
          <input class="form-input" id="pf-tnm" value="${sanitize(x.tnm_stage || '')}" placeholder="e.g., T3 N1 M0" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Biomarkers / molecular status</label>
          <input class="form-input" id="pf-biomarkers" value="${sanitize(x.biomarkers || '')}" placeholder="MSI-H, HER2, KRAS, PD-L1 CPS…" /></div>
        <div class="form-group"><label class="form-label">Diagnosed (month)</label>
          <input class="form-input" id="pf-diagnosis" type="month" value="${(x.diagnosis_date || '').slice(0, 7)}" /></div>
        <div class="form-group"><label class="form-label">Current treatment</label>
          <input class="form-input" id="pf-treatment" value="${sanitize(x.current_treatment || '')}" placeholder="e.g., FOLFOX cycle 4" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Treatment centre / hospital</label>
          <input class="form-input" id="pf-hospital" value="${sanitize(x.treating_hospital || '')}" /></div>
        <div class="form-group"><label class="form-label">Treating doctor</label>
          <input class="form-input" id="pf-doctor" value="${sanitize(x.treating_doctor || '')}" /></div>
        <div class="form-group"><label class="form-label">Referring doctor</label>
          <input class="form-input" id="pf-refdoctor" value="${sanitize(x.referring_doctor || '')}" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">ECOG performance status</label>
          <select class="form-select" id="pf-ecog">${opt(ECOG, x.ecog_status, 'Not assessed')}</select></div>
        <div class="form-group"><label class="form-label">Disease trajectory</label>
          <select class="form-select" id="pf-trajectory">${opt(TRAJECTORIES, x.trajectory, 'N/A')}</select></div>
        <div class="form-group"><label class="form-label">Stoma / feeding tube</label>
          <select class="form-select" id="pf-stoma">${opt(STOMA_TYPES, x.stoma_type, 'N/A')}</select></div>
      </div>
      <div class="form-group"><label class="form-checkbox"><input type="checkbox" id="pf-trial" ${x.clinical_trial_aware ? 'checked' : ''} /> <span>Knows about / involved in clinical trials</span></label></div>

      <div class="fsec"><span class="fsec-ico">${icon('users')}</span><div><h4>Care & household</h4><div class="fsec-sub">Caregiver, finances and home context: drives the vulnerability score</div></div></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Caregiver name</label>
          <input class="form-input" id="pf-cg-name" value="${sanitize(x.caregiver_name || '')}" /></div>
        <div class="form-group"><label class="form-label">Relationship to patient</label>
          <input class="form-input" id="pf-cg-rel" value="${sanitize(x.caregiver_relationship || '')}" placeholder="e.g., son, wife" /></div>
        <div class="form-group"><label class="form-label">Caregiver phone</label>
          <input class="form-input" id="pf-cg-phone" value="${sanitize(x.caregiver_phone_full || '')}" inputmode="tel" /></div>
        <div class="form-group"><label class="form-label">Caregiver gender</label>
          <select class="form-select" id="pf-cg-gender">
            <option value="">N/A</option>
            <option value="female" ${x.caregiver_gender === 'female' ? 'selected' : ''}>Woman</option>
            <option value="male" ${x.caregiver_gender === 'male' ? 'selected' : ''}>Man</option>
            <option value="other" ${x.caregiver_gender === 'other' ? 'selected' : ''}>Other</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">How are they paying for treatment?</label>
          <input class="form-input" id="pf-payment" value="${sanitize(x.payment_method || '')}" placeholder="e.g., Ayushman Bharat, savings, loan" /></div>
        <div class="form-group"><label class="form-label">Insurance</label>
          <select class="form-select" id="pf-insurance">
            ${['unknown', 'insured', 'uninsured', 'govt_scheme'].map(s => `<option value="${s}" ${(x.insurance_status || 'unknown') === s ? 'selected' : ''}>${capitalize(s)}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Economic status</label>
          <select class="form-select" id="pf-economic">
            ${['unknown', 'bpl', 'lower_middle', 'middle', 'upper_middle'].map(s => `<option value="${s}" ${(x.economic_status || 'unknown') === s ? 'selected' : ''}>${s === 'bpl' ? 'Below poverty line' : capitalize(s)}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-group" style="max-width:280px"><label class="form-label">Health literacy</label>
        <select class="form-select" id="pf-literacy">${opt(HEALTH_LITERACY, x.health_literacy, 'N/A')}</select></div>

      <div class="fsec"><span class="fsec-ico">${icon('shieldCheck')}</span><div><h4>Consent (DPDPA)</h4><div class="fsec-sub">Required before storing personal data</div></div></div>
      <div class="form-row">
        <div class="form-group"><label class="form-checkbox">
          <input type="checkbox" id="pf-consent" ${isEdit ? (x.consent_given ? 'checked' : '') : ''} />
          <span>Patient gave informed consent <span class="required">*</span></span></label></div>
        <div class="form-group"><label class="form-label">Consent method</label>
          <select class="form-select" id="pf-consent-method">
            ${[['verbal_during_call', 'Verbal during call'], ['written', 'Written'], ['digital', 'Digital'], ['guardian_consent', 'Guardian consent']].map(([k, l]) =>
              `<option value="${k}" ${(x.consent_method || 'verbal_during_call') === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="pf-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="pf-submit">${isEdit ? 'Save changes' : 'Register patient'}</button>
      </div>
    </form>
  `;

  showModal({ title: isEdit ? `Edit · ${sanitize(x.full_name)}` : 'Register new patient', content: el, size: 'xl' });
  el.querySelector('#pf-cancel').addEventListener('click', () => closeModal());

  el.querySelector('#patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => el.querySelector('#' + id)?.value.trim() || null;
    const num = (id) => { const n = el.querySelector('#' + id)?.value; return n === '' || n == null ? null : Number(n); };

    const name = v('pf-name');
    if (!name) { showToast('Patient name is required', 'warning'); return; }
    if (!el.querySelector('#pf-consent').checked) { showToast('Patient consent is required (DPDPA)', 'warning'); return; }

    const phone = v('pf-phone');
    const cgPhone = v('pf-cg-phone');
    const diagMonth = v('pf-diagnosis');

    const patientData = {
      full_name: name,
      age: num('pf-age'),
      gender: v('pf-gender') || 'prefer_not_to_say',
      phone_full: phone,
      phone_masked: phone ? 'XXXXX-X' + phone.replace(/\D/g, '').slice(-4) : null,
      email: v('pf-email'),
      primary_language: v('pf-language'),
      city: v('pf-city'), state: v('pf-state'),
      gi_subtype: v('pf-gi'),
      cancer_type: giLabel(v('pf-gi')) || x.cancer_type || null,
      cancer_stage: v('pf-stage') || 'unknown',
      tnm_stage: v('pf-tnm'),
      biomarkers: v('pf-biomarkers'),
      diagnosis_date: diagMonth ? diagMonth + '-01' : null,
      current_treatment: v('pf-treatment'),
      treating_hospital: v('pf-hospital'),
      treating_doctor: v('pf-doctor'),
      referring_doctor: v('pf-refdoctor'),
      ecog_status: num('pf-ecog'),
      trajectory: v('pf-trajectory'),
      stoma_type: v('pf-stoma'),
      clinical_trial_aware: el.querySelector('#pf-trial').checked,
      caregiver_name: v('pf-cg-name'),
      caregiver_relationship: v('pf-cg-rel'),
      caregiver_gender: v('pf-cg-gender'),
      caregiver_phone_full: cgPhone,
      caregiver_phone_masked: cgPhone ? 'XXXXX-X' + cgPhone.replace(/\D/g, '').slice(-4) : null,
      payment_method: v('pf-payment'),
      insurance_status: v('pf-insurance') || 'unknown',
      economic_status: v('pf-economic') || 'unknown',
      health_literacy: v('pf-literacy'),
      consent_given: true,
      consent_method: v('pf-consent-method'),
    };
    if (!isEdit) patientData.consent_date = new Date().toISOString();

    const submitBtn = el.querySelector('#pf-submit');
    submitBtn.disabled = true; submitBtn.innerHTML = '<div class="spinner"></div>';
    try {
      const sb = getSupabase();
      if (isEdit) {
        await mustWrite(sb.from('patients').update(patientData).eq('id', existing.id), 'patient');
        showToast('Patient updated', 'success');
      } else {
        patientData.created_by = getCurrentUser().id;
        const { error } = await sb.from('patients').insert(patientData);
        if (error) throw error;
        showToast('Patient registered', 'success');
      }
      closeModal();
      if (typeof onSaved === 'function') onSaved();
    } catch (err) {
      showToast('Could not save: ' + err.message, 'error');
      submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save changes' : 'Register patient';
    }
  });
}

// ============================================================
// DETAIL: WHO · ACTION · IMPACT
// ============================================================
let activeTab = 'overview';

async function renderPatientDetail(container, patientId, keepTab = false) {
  if (!keepTab) activeTab = 'overview';
  container.innerHTML = `<div class="card">${renderSkeleton(6)}</div>`;
  const sb = getSupabase();

  try {
    const [pRes, cRes, sRes, aRes, hRes] = await Promise.all([
      sb.from('patients').select('*, mentor:profiles!patients_assigned_to_fkey(full_name), nutritionist:profiles!patients_nutrition_owner_id_fkey(full_name)').eq('id', patientId).single(),
      sb.from('call_logs').select('*, profiles:caller_id(full_name)').eq('patient_id', patientId).order('call_date', { ascending: false }),
      sb.from('patient_services').select('*').eq('patient_id', patientId),
      sb.from('patient_assessments').select('*').eq('patient_id', patientId).order('recorded_at', { ascending: true }),
      sb.from('patient_assignment_history')
        .select('reason, team, changed_at, from:profiles!pah_from_user_fkey(full_name), to:profiles!pah_to_user_fkey(full_name), by:profiles!pah_changed_by_fkey(full_name)')
        .eq('patient_id', patientId)
        .order('changed_at', { ascending: true }),
    ]);
    if (pRes.error) throw pRes.error;
    const patient = pRes.data;
    const calls = cRes.data || [];
    const services = Object.fromEntries((sRes.data || []).map(s => [s.lever, s]));
    const assessments = aRes.data || [];
    // RLS hides rows from non-managers who were never a party to a handover;
    // an error (e.g., table not deployed yet) degrades to the empty state.
    if (hRes.error) console.warn('Assignment history unavailable:', hRes.error.message);
    const pocHistory = hRes.error ? [] : (hRes.data || []);

    const reload = () => renderPatientDetail(container, patientId, true);
    const deceased = patient.patient_status === 'deceased' || !!patient.date_of_death;

    // The count on the Documents tab. Its own query rather than part of the
    // Promise.all above, because a project that has not run sql/93 yet has no
    // patient_documents table at all and the whole patient page would 404 with
    // it in the batch. A missing table degrades to a zero, not to a blank page.
    let docCount = 0;
    {
      const { count, error } = await sb.from('patient_documents')
        .select('id', { count: 'exact', head: true })
        .eq('patient_id', patientId).is('deleted_at', null);
      if (error) console.warn('Documents unavailable:', error.message);
      else docCount = count ?? 0;
    }
    const supportCount = Object.values(services).filter(s => s.done && !OUTCOME_FLAGS.some(f => f.key === s.lever)).length;
    const AVATAR_COLORS = ['#006469', '#7A4C00', '#5B4892', '#295B86', '#106841', '#953028'];
    let h = 0; for (const ch of patient.full_name) h = ch.charCodeAt(0) + ((h << 5) - h);
    const avColor = AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
    const initials = patient.full_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    // Age and gender show only when we hold them. 'N/A yrs' used to sit directly
    // under the patient's name, so the most-read line on the page led with a gap.
    const whoBits = [];
    if (patient.age) whoBits.push(`${patient.age} yrs`);
    if (patient.gender && patient.gender !== 'prefer_not_to_say') whoBits.push(capitalize(patient.gender));

    container.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="back-to-patients" style="margin-bottom:var(--s4)">${icon('arrowLeft')}All patients</button>

      <div class="detail-head">
        <div class="detail-id">
          <span class="avatar avatar-lg avatar-ring" style="background:${avColor}">${initials}</span>
          <div class="detail-name">
            <h1>${sanitize(patient.full_name)}</h1>
            <div class="detail-sub">
              <span class="cell-mono">${patient.patient_code}</span>
              ${whoBits.length ? `<span>·</span><span>${whoBits.join(' · ')}</span>` : ''}
              <span>·</span><span>${[patient.city, patient.state].filter(Boolean).map(sanitize).join(', ') || 'Location unknown'}</span>
              ${statusBadge(patient.patient_status)}
              ${vulnerabilityBadge(patient.vulnerability_score)}
              ${patient.do_not_call ? '<span class="badge badge-danger badge-dot">Do not call</span>' : ''}
            </div>
          </div>
        </div>
        <div class="detail-actions">
          <select class="form-select" id="status-select" style="width:auto" title="Patient status">
            ${PATIENT_STATUSES.map(s => `<option value="${s.key}" ${patient.patient_status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}
          </select>
          <button class="btn btn-secondary" id="edit-patient-btn">${icon('edit')}Edit</button>
          <button class="btn btn-secondary" id="read-docs-btn">${icon('upload')}Upload documents</button>
          <button class="btn btn-secondary" id="assess-btn">${icon('activity')}Record wellbeing</button>
          ${!deceased ? `<button class="btn btn-gold" id="wa-share-btn">${icon('phone')}WhatsApp</button>` : ''}
          ${!deceased ? `<button class="btn btn-primary" id="log-call-btn">${icon('phoneCall')}Log a call</button>` : ''}
        </div>
      </div>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--ink-3);margin:6px 0 10px;letter-spacing:.22em;text-transform:uppercase">
        <b style="color:var(--gold);font-weight:600">Reach</b> · <b style="color:var(--primary);font-weight:600">Action</b> · <b style="color:var(--clay);font-weight:600">Impact</b>: one person, three lenses
      </div>
      <div class="detail-tabs" role="tablist">
        <button class="dtab ${activeTab === 'overview' ? 'active' : ''}" data-tab="overview">${icon('user')}Overview</button>
        <button class="dtab ${activeTab === 'support' ? 'active' : ''}" data-tab="support">${icon('handHeart')}Support given <span class="cnt">${supportCount}</span></button>
        <button class="dtab ${activeTab === 'wellbeing' ? 'active' : ''}" data-tab="wellbeing">${icon('activity')}Wellbeing <span class="cnt">${assessments.length}</span></button>
        <button class="dtab ${activeTab === 'calls' ? 'active' : ''}" data-tab="calls">${icon('phone')}Calls <span class="cnt">${calls.length}</span></button>
        <button class="dtab ${activeTab === 'documents' ? 'active' : ''}" data-tab="documents">${icon('fileText')}Documents <span class="cnt">${docCount}</span></button>
      </div>

      <div id="tab-content"></div>
    `;

    // Back goes where they came from (Calls, Concerns, the queue board, the
    // calling portal...), not always to the patients list. See goBack().
    container.querySelector('#back-to-patients').addEventListener('click', () => goBack('patients'));
    container.querySelector('#edit-patient-btn').addEventListener('click', () => showPatientForm(patient, reload));
    // The batch reader. One PDF, twenty photos or a mix, segmented into
    // documents and reviewed as one thing. See js/pages/docBatch.js.
    container.querySelector('#read-docs-btn')?.addEventListener('click', async () => {
      const { openDocumentBatch } = await import('./docBatch.js');
      await openDocumentBatch(patientId);
    });
    window.addEventListener('patient-updated', function once(e) {
      if (e.detail?.patientId !== patientId) return;
      window.removeEventListener('patient-updated', once);
      reload();
    });
    container.querySelector('#assess-btn')?.addEventListener('click', () =>
      openAssessmentFlow({ patient: { id: patient.id, full_name: patient.full_name }, role: getUserRole(), onSaved: reload }));
    container.querySelector('#log-call-btn')?.addEventListener('click', () =>
      openCallForm({ patient: { id: patient.id, full_name: patient.full_name }, onSaved: reload }));
    container.querySelector('#wa-share-btn')?.addEventListener('click', () =>
      openWhatsappShare({ patient, recipients: recipientsFromPatient(patient) }));

    container.querySelector('#status-select').addEventListener('change', async (e) => {
      const next = e.target.value;
      const apply = async (extra = {}) => {
        try {
          await mustWrite(sb.from('patients').update({ patient_status: next, ...extra }).eq('id', patient.id), 'status');
        } catch (err) {
          showToast('Could not change status: ' + err.message, 'error');
          e.target.value = patient.patient_status;
          return;
        }
        showToast('Status updated', 'success');
        // deceased → land on Overview where the bereavement panel lives
        if (next === 'deceased') activeTab = 'overview';
        reload();
      };
      if (next === 'deceased') {
        confirmModal(
          `Mark <strong>${sanitize(patient.full_name)}</strong> as deceased? The record moves to the bereavement workflow.`,
          () => apply(), { title: 'Mark deceased', confirmLabel: 'Yes, mark deceased' }
        );
        e.target.value = patient.patient_status; // revert until confirmed
      } else {
        await apply(next !== 'deceased' && patient.date_of_death ? { date_of_death: null } : {});
      }
    });

    const tabContent = container.querySelector('#tab-content');
    const renderTab = () => {
      if (activeTab === 'overview') renderOverviewTab(tabContent, patient, services, assessments, sb, reload, deceased, pocHistory);
      else if (activeTab === 'support') renderSupportTab(tabContent, patient, services, sb, reload);
      else if (activeTab === 'wellbeing') renderWellbeingTab(tabContent, patient, services, assessments, sb, reload);
      else if (activeTab === 'documents') renderDocumentsTab(tabContent, patient, sb, reload);
      else renderCallsTab(tabContent, patient, calls, reload);
    };
    container.querySelectorAll('.dtab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        container.querySelectorAll('.dtab').forEach(t => t.classList.toggle('active', t === tab));
        renderTab();
      });
    });
    renderTab();
  } catch (err) {
    console.error('Patient detail error:', err);
    container.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Patient not found</h4><p>${sanitize(err.message)}</p></div>`;
  }
}

// ---- Care history (POC handovers) ----
// Read-only timeline of who has held this patient. Managers assign from #team;
// there are deliberately no assignment actions here.
const POC_REASON_LABELS = {
  first_poc: 'First POC',
  backfill_transition: 'Earlier handover (reconstructed)',
  manual_assignment: 'Assigned by a manager',
  quick_fill: 'Quick-filled by a manager',
  queue_move_handover: 'Handed over with a queue move',
  leave_cover: 'Covered during leave',
  restored_after_leave: 'Restored after leave',
  auto_distribute: 'Auto-distributed',
  daily_rotation: 'Daily rotation',
  manual_update: 'Updated',
  // v89, the nutrition side of the same table
  nutrition_claim: 'Claimed',
  nutrition_claim_call: 'Claimed by reaching them on a call',
  nutrition_assignment: 'Assigned by a lead',
  nutrition_quick_fill: 'Quick-filled by a lead',
  nutrition_handover: 'Handed over with a queue move',
  nutrition_release: 'Handed back to Unclaimed',
  nutrition_backfill: 'Carried over from earlier nutrition work',
};

function careHistoryHtml(history) {
  if (!history.length) return '<div class="due-meta">No handovers recorded.</div>';
  const name = (prof, fallback) => prof?.full_name ? sanitize(prof.full_name) : fallback;
  const lines = history.map(r => {
    if (r.reason === 'first_poc') {
      return `<div class="due-meta">First POC: <strong style="color:var(--ink-2)">${name(r.to, 'Unassigned')}</strong> · ${formatDate(r.changed_at)}</div>`;
    }
    const label = POC_REASON_LABELS[r.reason] || POC_REASON_LABELS.manual_update;
    if (r.reason === 'nutrition_backfill') {
      return `<div class="due-meta"><strong style="color:var(--ink-2)">${name(r.to, 'Unassigned')}</strong> · ${label} · ${formatDate(r.changed_at)}</div>`;
    }
    const blank = r.team === 'nutrition' ? 'Unclaimed' : 'Unassigned';
    return `<div class="due-meta">${name(r.from, blank)} → <strong style="color:var(--ink-2)">${name(r.to, blank)}</strong> · ${label} · ${formatDate(r.changed_at)} · by ${name(r.by, 'system')}</div>`;
  });
  if (lines.length <= 5) return lines.join('');
  // Long trails collapse the older entries; the newest 5 stay visible.
  const older = lines.slice(0, lines.length - 5);
  return `<details>
    <summary style="cursor:pointer;font-size:12px;color:var(--ink-3)">${older.length} earlier change${older.length === 1 ? '' : 's'}</summary>
    <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">${older.join('')}</div>
  </details>${lines.slice(-5).join('')}`;
}

// ---- Overview tab ----
function renderOverviewTab(el, p, services, assessments, sb, reload, deceased, pocHistory = []) {
  // Two teams hand patients over for different reasons. Interleaving them in
  // one list would turn 96 patient records overnight into a timeline nobody
  // can read; the nutrition slice lives inside the nutrition banner instead.
  const nutHistory = pocHistory.filter(h => h.team === 'nutrition');
  pocHistory = pocHistory.filter(h => h.team !== 'nutrition');
  // The muted style exists only as '.kv .v.dim', so an empty cell has to carry
  // the class on its own .v element. On a child span nothing applies and 'N/A'
  // renders at the same ink and weight as the real value in the cell beside it.
  // These three build the whole .v, so any cell that can come back empty goes
  // through them and never hand-wraps a second .v of its own.
  const vHas = (html, extra = '') => `<div class="v${extra}">${html}</div>`;
  const vNone = (text = 'N/A', extra = '') => `<div class="v dim${extra}">${text}</div>`;
  const dash = (v, extra = '') => v ? vHas(sanitize(String(v)), extra) : vNone('N/A', extra);
  const gaps = deceased ? [] : dataGaps(p);
  // Current POC resolves through patients.assigned_to → profiles; the legacy
  // free-text assigned_caller_name (old import names) only shows when unassigned.
  const pocCell = p.assigned_to
    ? (p.mentor?.full_name ? vHas(sanitize(p.mentor.full_name)) : vNone())
    : (p.assigned_caller_name
      ? vHas(`${sanitize(p.assigned_caller_name)} <span style="color:var(--ink-4);font-weight:500">(legacy)</span>`)
      : vNone());
  // Nutrition, stated on the front page of the record. A nutritionist opening
  // someone from their worklist could not previously see WHY nutrition was on
  // for this person without digging into the Support tab, so it read as if
  // the patient had nothing to do with nutrition at all.
  const nutriOn = Object.values(services).filter(s => s.done && String(s.lever).startsWith('nutri'));
  // v89: who holds this patient for nutrition is a decision now, and this is
  // where the record states it and where it gets changed. A nutritionist
  // looking at an unheld patient gets the same Claim button as the worklist
  // card. The mentor's Current POC is a separate thing and stays put.
  const nutRole = getUserRole();
  const canClaimNut = nutRole === 'nutritionist' && !p.nutrition_owner_id && !deceased;
  const canDropNut = !!p.nutrition_owner_id && !deceased &&
    (isManagerOrAdmin() || (nutRole === 'nutritionist' && p.nutrition_owner_id === getCurrentProfile()?.id));
  const nutriBanner = (nutriOn.length || p.nutrition_owner_id) ? `
    <div class="card" style="margin-bottom:var(--s5);border-left:3px solid var(--ok)">
      <div style="display:flex;align-items:center;gap:11px;flex-wrap:wrap">
        <span class="stat-ico ok">${icon('leaf')}</span>
        <div style="flex:1;min-width:200px">
          <div class="info-value">${p.nutrition_owner_id
            ? `Nutrition care with <strong>${sanitize(p.nutritionist?.full_name || 'a nutritionist')}</strong>`
            : 'Nutrition support is on for this patient'}</div>
          <div class="due-meta">${nutriOn.length
            ? sanitize(nutriOn.map(s => leverLabel(s.lever)).join(' · ')) + (nutriOn[0].updated_at ? ` · last updated ${formatDate(nutriOn[0].updated_at)}` : '')
            : 'No nutrition work logged yet.'}${p.nutrition_owner_at ? ` · held since ${formatDate(p.nutrition_owner_at)}` : ''}</div>
        </div>
        ${p.nutrition_owner_id
          ? '<span class="badge badge-ok">In nutrition care</span>'
          : '<span class="badge badge-gold">Unclaimed</span>'}
        ${canClaimNut ? `<button class="btn btn-primary btn-sm" id="nut-claim-one">${icon('handHeart')}Claim</button>` : ''}
        ${canDropNut ? `<button class="btn btn-secondary btn-sm" id="nut-release-one">${icon('skip')}Hand back</button>` : ''}
      </div>
      ${nutHistory.length ? `<div style="margin-top:var(--s4)">
        <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-3)">Nutrition handovers</strong>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${careHistoryHtml(nutHistory)}</div>
      </div>` : ''}
    </div>` : '';

  el.innerHTML = `
    ${deceased ? `<div id="bereave-mount" style="margin-bottom:var(--s5)"></div>` : ''}
    ${nutriBanner}
    ${gaps.length ? `
    <div class="card" style="margin-bottom:var(--s5);border-left:3px solid var(--warn)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:11px">
          <span class="stat-ico warn">${icon('search')}</span>
          <div><div class="info-value">${gaps.length} detail${gaps.length === 1 ? '' : 's'} still unknown</div>
          <div class="due-meta">Callers get prompted for these at the right call stage, or fill them now if you know.</div></div>
        </div>
        <button class="btn btn-secondary btn-sm" id="gaps-edit-btn">${icon('edit')}Fill in</button>
      </div>
      <div class="chip-row" style="margin-top:12px">
        ${gaps.map(g => `<span class="badge ${g.stage >= 3 ? 'badge-neutral' : 'badge-warn'}" title="${g.ask.replace(/"/g, '&quot;')}">${g.label}${g.stage >= 3 ? ` · call ${g.stage}+` : ''}</span>`).join('')}
      </div>
    </div>` : ''}
    <div id="byc-mount"></div>
    <div class="content-grid">
      <div class="col-span-6"><div class="card">
        <div class="card-header"><div class="card-title">Clinical profile</div></div>
        <div class="kv">
          <div><div class="k">GI subtype</div>${giLabel(p.gi_subtype) ? vHas(giLabel(p.gi_subtype)) : dash(p.cancer_type)}</div>
          <div><div class="k">Stage</div>${p.cancer_stage && p.cancer_stage !== 'unknown' ? vHas(capitalize(p.cancer_stage)) : vNone('Unknown')}</div>
          <div><div class="k">TNM</div>${dash(p.tnm_stage)}</div>
          <div><div class="k">Biomarkers</div>${dash(p.biomarkers)}</div>
          <div><div class="k">Diagnosed</div>${p.diagnosis_date ? vHas(new Date(p.diagnosis_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })) : vNone()}</div>
          <div><div class="k">Treatment</div>${dash(p.current_treatment)}</div>
          <div><div class="k">ECOG</div>${p.ecog_status != null ? dash(ECOG.find(e2 => e2.key === p.ecog_status)?.label) : vNone('Not assessed')}</div>
          <div><div class="k">Trajectory</div>${dash(TRAJECTORIES.find(t => t.key === p.trajectory)?.label)}</div>
          <div><div class="k">Stoma</div>${dash(STOMA_TYPES.find(s => s.key === p.stoma_type)?.label)}</div>
          <div><div class="k">Hospital</div>${dash(p.treating_hospital)}</div>
          <div><div class="k">Treating doctor</div>${dash(p.treating_doctor)}</div>
          <div><div class="k">Referring doctor</div>${dash(p.referring_doctor)}</div>
          <div><div class="k">Trials aware</div><div class="v">${p.clinical_trial_aware ? 'Yes' : 'No'}</div></div>
        </div>
      </div></div>

      <div class="col-span-6"><div class="card">
        <div class="card-header"><div class="card-title">Contact & household</div></div>
        <div class="kv">
          <div><div class="k">Phone</div>${dash(p.phone_full || p.phone_masked, ' cell-mono')}</div>
          <div><div class="k">Email</div>${dash(p.email)}</div>
          <div><div class="k">Language</div>${dash(p.primary_language)}</div>
          <div><div class="k">Caregiver</div>${p.caregiver_name ? vHas(`${sanitize(p.caregiver_name)}${p.caregiver_relationship ? ' · ' + sanitize(p.caregiver_relationship) : ''}`) : vNone()}</div>
          <div><div class="k">Caregiver phone</div>${dash(p.caregiver_phone_full || p.caregiver_phone_masked, ' cell-mono')}</div>
          <div><div class="k">Paying via</div>${dash(p.payment_method)}</div>
          <div><div class="k">Insurance</div><div class="v">${capitalize(p.insurance_status || 'unknown')}</div></div>
          <div><div class="k">Economic</div><div class="v">${p.economic_status === 'bpl' ? 'Below poverty line' : capitalize(p.economic_status || 'unknown')}</div></div>
          <div><div class="k">Health literacy</div>${dash(HEALTH_LITERACY.find(l => l.key === p.health_literacy)?.label)}</div>
          <div><div class="k">Vulnerability</div><div class="v">${vulnerabilityBadge(p.vulnerability_score)} <span style="font-weight:500;font-size:12px;color:var(--ink-3)">of 10</span></div></div>
          <div><div class="k">Current POC</div>${pocCell}</div>
          <div><div class="k">Nutrition POC</div>${p.nutrition_owner_id
            ? vHas(sanitize(p.nutritionist?.full_name || 'N/A'))
            : vNone('Unclaimed')}</div>
        </div>
        <div style="margin-top:var(--s4)" class="kv">
          <div><div class="k">Consent</div><div class="v">${p.consent_given ? '<span class="badge badge-ok badge-dot">Given</span>' : '<span class="badge badge-danger badge-dot">Missing</span>'}</div></div>
          <div><div class="k">Method</div>${p.consent_method ? vHas(capitalize(p.consent_method)) : vNone()}</div>
          <div><div class="k">Retain until</div>${p.data_retention_until ? vHas(formatDate(p.data_retention_until)) : vNone()}</div>
        </div>
        <div style="margin-top:var(--s4)">
          <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-3)">Care history</strong>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${careHistoryHtml(pocHistory)}</div>
        </div>
        ${p.legacy_notes ? `<div style="margin-top:var(--s4);padding:12px 14px;background:var(--surface-3);border-radius:var(--r-sm);font:var(--t-sm);color:var(--ink-2)"><strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-3)">Notes from intake</strong><br>${sanitize(p.legacy_notes)}</div>` : ''}
      </div></div>
    </div>
  `;
  el.querySelector('#gaps-edit-btn')?.addEventListener('click', () => showPatientForm(p, reload));

  // Nutrition ownership, from the record itself. Same single write path the
  // worklist card uses, so the guard trigger and the history stay honest.
  const setNutOwner = async (btn, to, msg) => {
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;border-width:2px"></span>';
    try {
      const { data, error } = await sb.rpc('set_nutrition_owner', { p_patient_ids: [p.id], p_to: to });
      if (error) throw error;
      if ((data.taken || []).length) { showToast(`${data.taken[0].taken_by} claimed them just now.`, 'warning'); }
      else showToast(msg, 'success');
      reload();
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false; btn.innerHTML = label;
    }
  };
  el.querySelector('#nut-claim-one')?.addEventListener('click', (e) =>
    setNutOwner(e.currentTarget, getCurrentProfile()?.id, 'They are in your nutrition care now.'));
  el.querySelector('#nut-release-one')?.addEventListener('click', (e) =>
    setNutOwner(e.currentTarget, null, 'Handed back. Anyone on the nutrition team can pick them up.'));
  if (deceased) renderBereavePanel(el.querySelector('#bereave-mount'), p, assessments, sb, reload);
  // Not awaited: the record must not sit behind two more round trips, and
  // this card renders nothing at all when there is nothing to say.
  mountBeforeYouCall(el.querySelector('#byc-mount'), p);
}

// ---- Bereavement panel (deceased patients) ----
function renderBereavePanel(mount, p, assessments, sb, reload) {
  if (!mount) return;
  const me = getCurrentProfile();
  const bm = {};
  for (const m of BEREAVEMENT_MEASURES) {
    const series = assessments.filter(a => a.measure === m.key);
    bm[m.key] = series.length ? series[series.length - 1] : null;
  }
  mount.innerHTML = `
    <div class="bereave">
      <h3>Bereavement & legacy support</h3>
      <div class="sub">Supporting the family after loss: handled gently, recorded for impact.</div>
      <div class="form-row" style="margin-bottom:var(--s4)">
        <div class="form-group" style="margin-bottom:0"><label class="form-label">Date of death</label>
          <input class="form-input" type="date" id="bv-dod" value="${p.date_of_death || ''}" /></div>
        <div class="form-group" style="margin-bottom:0"><label class="form-label">Support type</label>
          <select class="form-select" id="bv-type">
            ${['', 'counselling', 'support group', 'check-in call', 'other'].map(t => `<option value="${t}" ${(p.bereavement_support_type || '') === t ? 'selected' : ''}>${t ? capitalize(t) : 'N/A'}</option>`).join('')}
          </select></div>
      </div>
      <div class="lever-row ${p.bereavement_support_offered ? 'on' : ''}">
        <label class="switch"><input type="checkbox" id="bv-offered" ${p.bereavement_support_offered ? 'checked' : ''} /><span class="knob"></span></label>
        <span class="lever-label">Bereavement support offered to the family</span>
      </div>
      <div class="lever-row ${p.funeral_debt ? 'on' : ''}">
        <label class="switch"><input type="checkbox" id="bv-debt" ${p.funeral_debt ? 'checked' : ''} /><span class="knob"></span></label>
        <span class="lever-label">Funeral caused financial debt</span>
      </div>
      <div class="form-row" style="margin-top:var(--s4)">
        <div class="form-group" style="margin-bottom:0"><label class="form-label">Child school retention: 6 months</label>
          <select class="form-select" id="bv-school6">${opt(SCHOOL_RETENTION, p.child_school_6m, 'N/A')}</select></div>
        <div class="form-group" style="margin-bottom:0"><label class="form-label">Child school retention: 12 months</label>
          <select class="form-select" id="bv-school12">${opt(SCHOOL_RETENTION, p.child_school_12m, 'N/A')}</select></div>
      </div>
      <div class="measure-grid" style="margin-top:var(--s4)">
        ${BEREAVEMENT_MEASURES.map(m => {
          const last = bm[m.key];
          return `<div class="measure-card ${last ? '' : 'measure-empty'}">
            <div class="measure-name">${m.label}</div>
            <div class="measure-val"><span class="now">${last ? Number(last.score) : 'Not yet'}</span>${last ? `<span class="of">/ ${m.max}</span>` : ''}</div>
            <div class="measure-foot"><span class="when">${last ? formatRelativeTime(last.recorded_at) : m.hint}</span>
              <button class="btn btn-ghost btn-sm" data-bvmeasure="${m.key}">${icon('plus')}Record</button></div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;

  const save = async (patch) => {
    try {
      await mustWrite(sb.from('patients').update(patch).eq('id', p.id), 'change');
      showToast('Saved', 'success');
    } catch (err) { showToast('Could not save: ' + err.message, 'error'); }
  };
  mount.querySelector('#bv-dod').addEventListener('change', (e) => save({ date_of_death: e.target.value || null }));
  mount.querySelector('#bv-type').addEventListener('change', (e) => save({ bereavement_support_type: e.target.value || null }));
  mount.querySelector('#bv-offered').addEventListener('change', (e) => { e.target.closest('.lever-row').classList.toggle('on', e.target.checked); save({ bereavement_support_offered: e.target.checked }); });
  mount.querySelector('#bv-debt').addEventListener('change', (e) => { e.target.closest('.lever-row').classList.toggle('on', e.target.checked); save({ funeral_debt: e.target.checked }); });
  mount.querySelector('#bv-school6').addEventListener('change', (e) => save({ child_school_6m: e.target.value || null }));
  mount.querySelector('#bv-school12').addEventListener('change', (e) => save({ child_school_12m: e.target.value || null }));
  mount.querySelectorAll('[data-bvmeasure]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = BEREAVEMENT_MEASURES.find(x => x.key === btn.dataset.bvmeasure);
      openScoreModal(m, p, sb, me, reload);
    });
  });
}

// ---- Support tab (ACTION levers) ----
// The Support tab used to render all 20 levers, in 4 groups, every time. The
// average family has 2.56 of them ticked, so 17 or 18 rows were always empty
// switches and the tab read as "we have done nothing for this person" even for
// a family we had genuinely helped. Measured across the 782 active patients:
// 287 have nothing recorded at all, and the other 495 average 2.56 done.
// Both halves of "the support given sections are literally empty everywhere".
//
// So: lead with what actually happened, name the blank case honestly instead of
// drawing a wall of switches, and put the full catalogue one tap away.
function renderSupportTab(el, p, services, sb, reload) {
  const me = getCurrentProfile();
  const byKey = {};
  LEVER_GROUPS.forEach(g => g.levers.forEach(l => { byKey[l.key] = l; }));

  const doneKeys = Object.keys(services || {})
    .filter(k => services[k]?.done && byKey[k])
    .sort((a, b) => new Date(services[b].updated_at || services[b].recorded_at || 0)
                  - new Date(services[a].updated_at || services[a].recorded_at || 0));
  const first = sanitize((p.full_name || '').split(' ')[0] || 'them');

  const givenHTML = doneKeys.length
    ? `<div class="lever-group">${doneKeys.map(k => renderLeverRow(byKey[k], services[k])).join('')}</div>`
    : `<div class="empty" style="padding:22px 18px">
         <div class="ico-wrap">${icon('handHeart')}</div>
         <h4>Nothing recorded for ${first} yet</h4>
         <p>Either we have not been able to help yet, or it happened on a call and was never ticked.
            Record it below; it is what the impact report counts.</p>
       </div>`;

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">What we have done for ${first}</div>
        <div class="card-subtitle">${doneKeys.length
          ? `${doneKeys.length} ${doneKeys.length === 1 ? 'thing' : 'things'} recorded. Anything we sent that we have not followed up on is flagged below.`
          : 'Nothing is recorded against this family yet.'}</div></div>
      </div>
      ${givenHTML}
      <div id="sup-loops"></div>
    </div>
    <details class="card" id="sup-all" style="padding:0">
      <summary style="display:flex;align-items:center;justify-content:space-between;gap:10px;
        padding:14px 18px;min-height:44px;cursor:pointer;font:var(--t-body-strong)">
        <span>Record something else</span>
        <span class="badge badge-neutral">${Object.keys(byKey).length} levers</span>
      </summary>
      <div style="padding:0 0 var(--s4)">
      ${LEVER_GROUPS.map(g => `
        <div class="lever-group">
          <div class="lever-group-title">${g.group}</div>
          ${g.levers.filter(l => !(services[l.key]?.done)).map(l => renderLeverRow(l, services[l.key])).join('')}
        </div>`).join('')}
      </div>
    </details>
  `;
  bindLeverRows(el, p, sb, me);
  loadOpenLoops(el.querySelector('#sup-loops'), p, sb);
}

// What we sent and never asked about. This is the whole point of sql/85: the
// programme could say what it SENT and never what LANDED, because no screen
// ever came back to the question.
async function loadOpenLoops(mount, p, sb) {
  if (!mount) return;
  let loops = [];
  try {
    const { data } = await sb.from('v_open_loops')
      .select('offer_lever, question_en, days_since_offer')
      .eq('patient_id', p.id).order('rank').limit(6);
    loops = data || [];
  } catch { /* the view is new; an older deploy just shows nothing */ }
  if (!loops.length) { mount.innerHTML = ''; return; }
  mount.innerHTML = `
    <div class="lever-group">
      <div class="lever-group-title">Still to ask ${sanitize((p.full_name || '').split(' ')[0] || 'them')}</div>
      ${loops.map(l => `
        <div class="lever-row" style="align-items:flex-start">
          <span class="stat-ico warn" style="width:30px;height:30px;border-radius:8px;flex:none">${icon('clock')}</span>
          <div style="flex:1;min-width:0">
            <div class="lever-label">${sanitize(l.question_en || '')}</div>
            <div class="due-meta">Sent ${l.days_since_offer} day${l.days_since_offer === 1 ? '' : 's'} ago. Ask on the next call and record the answer.</div>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderLeverRow(lever, svc) {
  const on = !!(svc && svc.done);
  let extra = '';
  if (lever.field === 'amount') {
    extra = `<div class="lever-extra" ${on ? '' : 'style="display:none"'}><input class="input" type="number" min="0" data-extra="amount" placeholder="₹" value="${svc?.amount ?? ''}" title="${lever.fieldLabel}" /></div>`;
  } else if (lever.field === 'sessions') {
    extra = `<div class="lever-extra" ${on ? '' : 'style="display:none"'}><input class="input" type="number" min="0" max="200" data-extra="sessions" placeholder="#" value="${svc?.sessions ?? ''}" title="${lever.fieldLabel}" style="width:84px" /></div>`;
  } else if (lever.field === 'outcome') {
    extra = `<div class="lever-extra" ${on ? '' : 'style="display:none"'}><select class="select" data-extra="outcome" title="${lever.fieldLabel}">
      <option value="">${lever.fieldLabel}…</option>
      ${lever.options.map(o => `<option value="${o.key}" ${svc?.outcome === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select></div>`;
  } else if (lever.field === 'detail') {
    extra = `<div class="lever-extra" ${on ? '' : 'style="display:none"'}><input class="input" data-extra="detail" placeholder="${lever.fieldLabel}…" value="${sanitize(svc?.detail || '')}" style="width:210px" /></div>`;
  }
  const meta = on && svc?.recorded_at ? `<div class="lever-meta">recorded ${formatRelativeTime(svc.updated_at || svc.recorded_at)}</div>` : '';
  return `
    <div class="lever-row ${on ? 'on' : ''}" data-lever="${lever.key}">
      <label class="switch"><input type="checkbox" data-toggle ${on ? 'checked' : ''} /><span class="knob"></span></label>
      <span class="lever-label">${lever.label}</span>
      ${extra}${meta}
    </div>`;
}

function bindLeverRows(scope, patient, sb, me) {
  scope.querySelectorAll('.lever-row[data-lever]').forEach(row => {
    const lever = row.dataset.lever;
    const upsert = async () => {
      const done = row.querySelector('[data-toggle]').checked;
      const payload = {
        patient_id: patient.id, lever, done,
        recorded_by: me?.id || getCurrentUser()?.id,
      };
      const amount = row.querySelector('[data-extra="amount"]')?.value;
      const sessions = row.querySelector('[data-extra="sessions"]')?.value;
      const outcome = row.querySelector('[data-extra="outcome"]')?.value;
      const detail = row.querySelector('[data-extra="detail"]')?.value;
      if (amount !== undefined) payload.amount = amount === '' ? null : Number(amount);
      if (sessions !== undefined) payload.sessions = sessions === '' ? null : Number(sessions);
      if (outcome !== undefined) payload.outcome = outcome || null;
      if (detail !== undefined) payload.detail = detail?.trim() || null;
      const { error } = await sb.from('patient_services').upsert(payload, { onConflict: 'patient_id,lever' });
      if (error) showToast('Could not save: ' + error.message, 'error');
    };

    row.querySelector('[data-toggle]').addEventListener('change', (e) => {
      const on = e.target.checked;
      row.classList.toggle('on', on);
      const extra = row.querySelector('.lever-extra');
      if (extra) extra.style.display = on ? '' : 'none';
      upsert();
    });
    row.querySelectorAll('.lever-extra .input, .lever-extra .select').forEach(inp => {
      inp.addEventListener('change', upsert);
    });
  });
}

// ---- Wellbeing tab (IMPACT scores) ----
function renderWellbeingTab(el, p, services, assessments, sb, reload) {
  const me = getCurrentProfile();
  const seriesOf = (key) => assessments.filter(a => a.measure === key);

  el.innerHTML = `
    <div class="card" style="margin-bottom:var(--s5)">
      <div class="card-header">
        <div><div class="card-title">Wellbeing scores</div>
        <div class="card-subtitle">First entry is the baseline; every follow-up shows the change our support made.</div></div>
        <button class="btn btn-primary btn-sm" id="wb-guided-btn">${icon('activity')}Guided check-in</button>
      </div>
      <div class="measure-grid">
        ${MEASURES.map(m => {
          const series = seriesOf(m.key);
          if (!series.length) {
            return `<div class="measure-card measure-empty">
              <div class="measure-name">${m.label}</div><div class="measure-hint">${m.hint}</div>
              <div class="measure-val"><span class="now">No baseline</span></div>
              <div class="measure-foot"><span class="when"></span><button class="btn btn-ghost btn-sm" data-measure="${m.key}">${icon('plus')}Baseline</button></div>
            </div>`;
          }
          const first = Number(series[0].score), last = Number(series[series.length - 1].score);
          const delta = last - first;
          const better = delta * m.dir > 0, worse = delta * m.dir < 0;
          const cls = series.length === 1 || delta === 0 ? 'flat' : better ? 'good' : 'bad';
          const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '·';
          return `<div class="measure-card">
            <div class="measure-name">${m.label}</div><div class="measure-hint">${m.hint}</div>
            <div class="measure-val"><span class="now">${last}</span><span class="of">/ ${m.max}</span>
              <span class="measure-delta ${cls}">${series.length === 1 ? 'baseline' : `${arrow} ${Math.abs(delta)} ${better ? 'better' : worse ? 'worse' : ''}`}</span></div>
            <div class="measure-foot"><span class="when">${series.length} ${series.length === 1 ? 'entry' : 'entries'} · ${formatRelativeTime(series[series.length - 1].recorded_at)}</span>
              <button class="btn btn-ghost btn-sm" data-measure="${m.key}">${icon('plus')}Add</button></div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div id="wb-sessions" style="margin-bottom:var(--s5)"></div>

    <div class="card">
      <div class="card-header"><div class="card-title">Outcome flags</div></div>
      ${OUTCOME_FLAGS.map(l => renderLeverRow(l, services[l.key])).join('')}
    </div>
  `;

  loadSessionsCard(el.querySelector('#wb-sessions'), p, sb);
  el.querySelector('#wb-guided-btn')?.addEventListener('click', () =>
    openAssessmentFlow({ patient: { id: p.id, full_name: p.full_name }, role: getUserRole(), onSaved: reload }));
  el.querySelectorAll('[data-measure]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = MEASURES.find(x => x.key === btn.dataset.measure);
      openScoreModal(m, p, sb, me, reload);
    });
  });
  bindLeverRows(el, p, sb, me);
}

// 1:1 session history for this patient: read-only here. Invitations happen
// on calls; scheduling and outcomes live on the Sessions page.
async function loadSessionsCard(mount, p, sb) {
  if (!mount) return;
  let sessions = [];
  try {
    const { data } = await sb.from('care_sessions')
      .select('*, assignee:profiles!care_sessions_assigned_to_fkey(full_name), inviter:profiles!care_sessions_invited_by_fkey(full_name)')
      .eq('patient_id', p.id)
      .order('created_at', { ascending: false });
    sessions = data || [];
  } catch { /* table readable to all authenticated; failures just hide the card */ }
  if (!sessions.length) { mount.innerHTML = ''; return; }
  const held = sessions.filter(s => s.status === 'held').length;
  mount.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">1:1 sessions</div>
        <div class="card-subtitle">${held ? `${held} held so far: compare the scores above before and after.` : 'Invited on calls; the specialist team schedules and holds them.'}</div></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${sessions.slice(0, 12).map(s => {
          const st = sessionStatus(s.status); const k = sessionKind(s.kind);
          const when = s.status === 'held' && s.held_at ? formatRelativeTime(s.held_at)
            : s.status === 'scheduled' && s.scheduled_at ? new Date(s.scheduled_at).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
            : formatRelativeTime(s.created_at);
          return `<div class="lever-row" style="align-items:center">
            <span class="stat-ico ${s.kind === 'nutrition' ? 'ok' : s.kind === 'caregiver' ? 'info' : 'warn'}" style="width:30px;height:30px;border-radius:8px">${icon(k.icon)}</span>
            <div style="flex:1;min-width:150px">
              <div class="lever-label">${k.label}<span class="badge badge-${st.tone}" style="margin-left:8px">${st.label}</span></div>
              <div class="due-meta">${when}${s.assignee?.full_name ? ' · with ' + s.assignee.full_name : ''}${s.duration_mins ? ' · ' + s.duration_mins + ' min' : ''}</div>
              ${s.session_notes ? `<div class="due-meta" style="font-style:italic;margin-top:2px">${s.session_notes}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function openScoreModal(measure, patient, sb, me, onSaved) {
  const instrument = INSTRUMENTS[measure.key];
  const el = document.createElement('div');

  if (instrument) {
    // Guided mode: administer the real questionnaire, item by item.
    // The intern reads each question aloud; the total sums itself.
    // An item is an object, { q, hindi, probe }, and MUST carries its own
    // per-item `options` because BMI / weight-loss / acute-illness each score on
    // a different band. Reading the item as a string printed "[object Object]",
    // and instrument.options is undefined for MUST, which killed the modal.
    const qText = (it) => (it && typeof it === 'object') ? it.q : it;
    const qOpts = (it) => (it && typeof it === 'object' && it.options) ? it.options : (instrument.options || []);
    const answers = new Array(instrument.items.length).fill(null);
    el.innerHTML = `
      <div class="strategy" style="margin-bottom:var(--s4)">
        <div class="strategy-head" style="margin-bottom:4px"><span class="strategy-ico">${icon('message')}</span>
          <div class="strategy-title">How to administer</div></div>
        <div class="strategy-body">${sanitize(instrument.intro)}</div>
      </div>
      ${instrument.note ? `<div class="strategy" style="margin-bottom:var(--s4)">
        <div class="strategy-head" style="margin-bottom:4px"><span class="strategy-ico">${icon('alertCircle')}</span>
          <div class="strategy-title">Before you score</div></div>
        <div class="strategy-body">${sanitize(instrument.note)}</div>
      </div>` : ''}
      ${instrument.items.map((it, qi) => {
        const opts = qOpts(it);
        return `
        <div class="field" style="margin-bottom:var(--s4)">
          <label style="font-weight:600;color:var(--ink)">${qi + 1}. ${sanitize(qText(it))}</label>
          ${it && it.hindi ? `<div style="font:var(--t-sm);font-style:italic;color:var(--ink-2);margin:2px 0 4px">${sanitize(it.hindi)}</div>` : ''}
          ${it && it.probe ? `<div style="font:var(--t-xs);color:var(--ink-3);margin-bottom:6px">Probe: ${sanitize(it.probe)}</div>` : ''}
          <div class="seg" style="grid-template-columns:repeat(${opts.length},1fr)" data-q="${qi}">
            ${opts.map(([label, pts]) => `<button type="button" class="seg-btn" data-pts="${pts}" style="padding:9px 6px"><span>${sanitize(label)}</span></button>`).join('')}
          </div>
        </div>`;
      }).join('')}
      <div class="timer" style="margin-bottom:var(--s4)">
        <div><div class="info-label">Total score</div><div class="timer-time tnum" id="sc-total">…</div></div>
        <div style="text-align:right;max-width:55%"><div class="info-label">Reading it</div><div style="font:var(--t-xs);color:var(--ink-2)">${instrument.interpret}</div></div>
      </div>
      <div class="field"><label>Note (optional)</label><input class="input" id="sc-note" placeholder="Context, their words, anything clinical…" /></div>
      <div class="form-actions">
        <button class="btn btn-secondary" id="sc-cancel">Cancel</button>
        <button class="btn btn-primary" id="sc-save" disabled>${icon('check')}Save score</button>
      </div>
    `;
    showModal({ title: measure.label, content: el, size: 'lg' });

    const totalEl = el.querySelector('#sc-total');
    const saveBtn = el.querySelector('#sc-save');
    const refresh = () => {
      const done = answers.every(a => a != null);
      totalEl.textContent = done ? answers.reduce((a, b) => a + b, 0) + ' / ' + measure.max : `${answers.filter(a => a != null).length} of ${answers.length} answered`;
      saveBtn.disabled = !done;
    };
    el.querySelectorAll('[data-q]').forEach(group => {
      const qi = Number(group.dataset.q);
      group.querySelectorAll('.seg-btn').forEach(btn => btn.addEventListener('click', () => {
        answers[qi] = Number(btn.dataset.pts);
        group.querySelectorAll('.seg-btn').forEach(b => b.className = 'seg-btn');
        btn.className = 'seg-btn on tone-primary';
        refresh();
      }));
    });
    refresh();
    el.querySelector('#sc-cancel').addEventListener('click', () => closeModal());
    saveBtn.addEventListener('click', async () => {
      const total = answers.reduce((a, b) => a + b, 0);
      saveBtn.disabled = true; saveBtn.innerHTML = '<div class="spinner"></div>';
      const { error } = await sb.from('patient_assessments').insert({
        patient_id: patient.id, measure: measure.key, score: total,
        // Same shape the guided flow writes (components/assessmentFlow.js):
        // the question TEXT, not the whole item object.
        details: { instrument: measure.key, items: instrument.items.map((it, i) => ({ q: qText(it), points: answers[i] })), total },
        notes: el.querySelector('#sc-note').value.trim() || null,
        recorded_by: me?.id || getCurrentUser()?.id,
      });
      if (error) { showToast('Could not save: ' + error.message, 'error'); saveBtn.disabled = false; saveBtn.innerHTML = `${icon('check')}Save score`; }
      else { closeModal(); showToast(`${measure.label} recorded: ${total}/${measure.max}`, 'success'); if (onSaved) onSaved(); }
    });
    return;
  }

  // Simple mode: one number on a stepper.
  let val = Math.round((measure.min + measure.max) / 2);
  el.innerHTML = `
    <p style="margin:0 0 6px;font:var(--t-sm);color:var(--ink-2)">${measure.hint}</p>
    <div style="display:flex;align-items:center;gap:16px;margin:var(--s4) 0">
      <div class="stepper">
        <button type="button" id="sc-minus" aria-label="Decrease">-</button>
        <input class="stepper-val" id="sc-val" value="${val}" inputmode="numeric" />
        <button type="button" id="sc-plus" aria-label="Increase">+</button>
      </div>
      <span style="font:var(--t-sm);color:var(--ink-3)">range ${measure.min}-${measure.max}</span>
    </div>
    <div class="field"><label>Note (optional)</label><input class="input" id="sc-note" placeholder="Context for this score…" /></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="sc-cancel">Cancel</button>
      <button class="btn btn-primary" id="sc-save">${icon('check')}Save score</button>
    </div>
  `;
  showModal({ title: measure.label, content: el });

  const valEl = el.querySelector('#sc-val');
  const clamp = (n) => Math.max(measure.min, Math.min(measure.max, n));
  el.querySelector('#sc-minus').addEventListener('click', () => { val = clamp(val - 1); valEl.value = val; });
  el.querySelector('#sc-plus').addEventListener('click', () => { val = clamp(val + 1); valEl.value = val; });
  valEl.addEventListener('change', () => { val = clamp(Number(valEl.value) || measure.min); valEl.value = val; });
  el.querySelector('#sc-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#sc-save').addEventListener('click', async () => {
    const btn = el.querySelector('#sc-save');
    btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>';
    const { error } = await sb.from('patient_assessments').insert({
      patient_id: patient.id, measure: measure.key, score: val,
      notes: el.querySelector('#sc-note').value.trim() || null,
      recorded_by: me?.id || getCurrentUser()?.id,
    });
    if (error) { showToast('Could not save: ' + error.message, 'error'); btn.disabled = false; btn.innerHTML = `${icon('check')}Save score`; }
    else { closeModal(); showToast('Score recorded', 'success'); if (onSaved) onSaved(); }
  });
}

// ---- Calls tab ----
// ---- Documents ----
//
// Where a mentor actually uses the reader. Until this tab existed the only way
// in was a button in a row of six on the patient header, labelled "Read a whole
// folder", which describes what the machine does and not what she is doing.
// She is uploading what the family just sent her on WhatsApp.
//
// The tab also has to answer "did I already send these", which nothing did.
// A mentor who cannot see that a batch went through sends it again, and the
// second reading proposes the same fields a second time.
const BATCH_STATUS = {
  uploading: 'still uploading',
  segmenting: 'sorting the pages',
  extracting: 'being read',
  ready_for_review: 'read, waiting for you',
  reviewed: 'reviewed',
  discarded: 'discarded',
  failed: 'could not be read',
};

export async function renderDocumentsTab(el, p, sb, reload) {
  el.innerHTML = '<div class="card"><div class="spinner"></div></div>';

  const [bRes, dRes] = await Promise.all([
    // uploaded_at, NOT created_at. Both of these tables stamp uploaded_at and
    // neither has created_at, so the first version of this tab rendered its
    // error state on every patient with
    //   column document_batches.created_at does not exist
    // which the live browser check caught on its first run.
    sb.from('document_batches')
      .select('id, status, page_count, note, uploaded_at, reviewed_at')
      .eq('patient_id', p.id).is('deleted_at', null)
      .order('uploaded_at', { ascending: false }).limit(20),
    sb.from('patient_documents')
      .select('id, batch_id, doc_type, document_date, page_count, uploaded_at')
      .eq('patient_id', p.id).is('deleted_at', null)
      .order('uploaded_at', { ascending: false }).limit(200),
  ]);

  // An error and an empty list look identical on screen unless this is checked,
  // and "no documents yet" is the answer a mentor acts on by uploading them
  // again. sql/73 made that mistake for call_logs and it made every later
  // "the data is missing" report unanswerable.
  const failed = bRes.error || dRes.error;
  const batches = bRes.data || [];
  const docs = dRes.data || [];

  const upload = `<button class="btn btn-primary btn-sm" id="doc-upload-btn">${icon('upload')}Upload documents</button>`;

  if (failed) {
    el.innerHTML = `<div class="card"><div class="empty">
      <div class="ico-wrap">${icon('alertCircle')}</div>
      <h4>We could not load this patient's documents</h4>
      <p>${sanitize(bRes.error?.message || dRes.error?.message || 'unknown error')}</p>
      <p class="form-hint">This is not the same as there being none. Do not re-upload
      until someone has looked at this.</p>
    </div></div>`;
    return;
  }

  const byBatch = {};
  for (const d of docs) (byBatch[d.batch_id] ??= []).push(d);

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Documents the family has sent</div>
        ${upload}
      </div>
      <p class="form-hint">Photos, screenshots or a PDF, in any order. We read them,
      check every answer back against the page, and show you what to confirm before
      anything is saved. Nothing goes onto the record until you tick it.</p>
      ${!batches.length ? `<div class="empty">
          <div class="ico-wrap">${icon('fileText')}</div>
          <h4>Nothing uploaded yet</h4>
          <p>Ask the family to send their hospital papers, then upload them here.</p>
        </div>`
      : `<div>${batches.map((b) => {
          const mine = byBatch[b.id] || [];
          const cls = b.status === 'failed' ? 'doc-callout-danger'
                    : b.status === 'ready_for_review' ? 'doc-callout-warn' : '';
          return `<div class="doc-callout ${cls}">
            <strong>${icon('fileText')} ${b.page_count || mine.length} page(s),
              ${BATCH_STATUS[b.status] || sanitize(b.status)}</strong>
            <p>${new Date(b.uploaded_at).toLocaleString()}${
              b.reviewed_at ? ' &middot; reviewed ' + new Date(b.reviewed_at).toLocaleDateString() : ''}</p>
            ${b.note ? `<p class="form-hint">${sanitize(b.note)}</p>` : ''}
            ${mine.length ? `<ul style="margin:6px 0 0 18px">${mine.map((d) =>
              `<li>${sanitize(docLabel(d.doc_type))}${
                d.document_date ? ` <span class="doc-field-where">${sanitize(d.document_date)}</span>` : ''}${
                d.page_count > 1 ? ` <span class="doc-field-where">${d.page_count} pages</span>` : ''}</li>`
              ).join('')}</ul>` : ''}
          </div>`;
        }).join('')}</div>`}
    </div>`;

  el.querySelector('#doc-upload-btn')?.addEventListener('click', async () => {
    const { openDocumentBatch } = await import('./docBatch.js');
    await openDocumentBatch(p.id);
    reload();
  });
}

/** The same class labels the batch reader uses, without importing the whole
 *  module for one map. A class this file has not heard of shows as itself. */
function docLabel(cls) {
  const L = {
    treatment_protocol: 'Treatment protocol', drug_calculation: 'Day-care drug sheet',
    nursing_record: 'Nursing record', registration_form: 'Registration slip',
    file_cover: 'File cover', id_card: 'ID card', cost_certificate: 'Cost certificate',
    laboratory_report: 'Laboratory report', radiology_report: 'Radiology report',
    imaging_report: 'Imaging report', histopathology: 'Histopathology',
    pathology_addendum: 'Pathology addendum', endoscopy_report: 'Endoscopy / ERCP',
    device_record: 'Device / PICC card', discharge_summary: 'Discharge summary',
    prescription: 'Prescription', opd_note: 'OPD note', referral_letter: 'Referral letter',
    consent_form: 'Consent form', scheme_card: 'Scheme card',
    income_certificate: 'Income certificate', disability_certificate: 'Disability certificate',
    ration_card: 'Ration card', insurance_document: 'Insurance document',
    ngo_sanction_letter: 'NGO sanction letter', transfusion_record: 'Transfusion record',
    bill_receipt: 'Bill / receipt', not_a_medical_document: 'Not a medical document',
  };
  return L[cls] || (cls ? String(cls).replace(/_/g, ' ') : 'Document');
}

function renderCallsTab(el, p, calls, reload) {
  const toneOf = (s) => ({ connected: 'ok', no_answer: 'warn', busy: 'warn', callback_requested: 'info', voicemail: 'neutral', wrong_number: 'danger' })[s] || 'neutral';
  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Call history</div>
        ${p.patient_status !== 'deceased' ? `<button class="btn btn-primary btn-sm" id="tab-log-call">${icon('plus')}Log a call</button>` : ''}
      </div>
      ${calls.length === 0
        ? `<div class="empty"><div class="ico-wrap">${icon('phone')}</div><h4>No calls yet</h4><p>The first conversation starts the story.</p></div>`
        : `<div class="tl">
            ${calls.map(c => {
              const reqs = (c.structured?.requirements || []).slice(0, 8);
              const reqText = c.requirements_noted && !reqs.length ? c.requirements_noted : '';
              const cond = CONDITIONS.find(x => x.key === c.patient_condition);
              const wa = [];
              if (c.whatsapp_link_sent) wa.push('link sent');
              if (c.whatsapp_group_joined) wa.push('joined group');
              return `<div class="tl-item">
                <span class="tl-dot ${toneOf(c.dial_status)}"></span>
                <div class="tl-head">
                  ${getDialStatusBadge(c.dial_status)}
                  ${c.receptiveness_bucket ? `<span class="badge badge-primary">${capitalize(c.receptiveness_bucket.replace(/_/g, ' '))}</span>` : ''}
                  ${c.patient_mindset ? `<span class="badge badge-neutral">${capitalize(c.patient_mindset)}</span>` : ''}
                  ${cond ? `<span class="badge badge-${cond.tone === 'ok' ? 'ok' : cond.tone === 'danger' ? 'danger' : cond.tone === 'warn' ? 'warn' : 'neutral'}">${cond.label}</span>` : ''}
                  <span class="tl-when">${capitalize((c.profiles?.full_name || c.contacted_by_name || 'N/A').toLowerCase())} · ${formatDate(c.call_date)} · ${c.call_duration_mins || 0} min</span>
                </div>
                ${c.caller_notes ? `<div class="tl-body">${sanitize(c.caller_notes)}</div>` : ''}
                ${reqText ? `<div class="tl-body"><strong>Asked for:</strong> ${sanitize(reqText)}</div>` : ''}
                ${c.feedback_patient ? `<div class="tl-body" style="font-style:italic">“${sanitize(c.feedback_patient)}” · patient</div>` : ''}
                ${c.feedback_caregiver ? `<div class="tl-body" style="font-style:italic">“${sanitize(c.feedback_caregiver)}” · caregiver</div>` : ''}
                ${reqs.length ? `<div class="tl-chips">${reqs.map(r => `<span class="badge badge-gold">${sanitize(r)}</span>`).join('')}</div>` : ''}
                <div class="tl-chips">
                  ${wa.length ? `<span class="badge badge-ok">WhatsApp: ${wa.join(' · ')}</span>` : ''}
                  ${c.main_request_resolved === true ? `<span class="badge badge-ok">Request resolved</span>` : c.main_request_resolved === false ? `<span class="badge badge-warn">Request still open</span>` : ''}
                  ${c.unplanned_interruption === true ? `<span class="badge badge-danger">Treatment interrupted</span>` : ''}
                </div>
                ${c.unplanned_interruption === true && c.unplanned_interruption_reason ? `<div class="tl-body" style="color:var(--color-danger)">⚠ ${sanitize(c.unplanned_interruption_reason)}</div>` : ''}
                ${c.followup_strategy_notes ? `<div class="tl-body" style="opacity:.85"><strong>For the next caller:</strong> ${sanitize(c.followup_strategy_notes)}</div>` : ''}
                ${c.follow_up_date ? `<div class="tl-when" style="margin-top:6px">${icon('calendar')} next check-in ${formatDate(c.follow_up_date)}</div>` : ''}
              </div>`;
            }).join('')}
          </div>`}
    </div>
  `;
  el.querySelector('#tab-log-call')?.addEventListener('click', () =>
    openCallForm({ patient: { id: p.id, full_name: p.full_name }, onSaved: reload }));
}
