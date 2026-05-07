// ============================================================
// Patient Navigator — Patients Page
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentUser, isAdmin, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { formatDate, capitalize, getDialStatusBadge, exportToCSV } from '../utils/formatters.js';
import { sanitize, validateRequired, validateAge, validatePinCode } from '../utils/validators.js';
import { navigate } from '../router.js';

let currentPage = 1;
const PAGE_SIZE = 25;

export async function renderPatients(container, params) {
  if (params?.id) {
    await renderPatientDetail(container, params.id);
    return;
  }

  const userRole = (await getSupabase().from('profiles').select('role').eq('id', getCurrentUser().id).single())?.data?.role;
  const canExport = ['admin', 'manager'].includes(userRole);
  const canCreate = userRole !== 'content';

  container.innerHTML = `
    <div class="page-header">
      <h1>Patients</h1>
      <div class="flex gap-2">
        ${canExport ? `<button class="btn btn-secondary" id="export-patients-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export CSV
        </button>` : ''}
        ${canCreate ? `<button class="btn btn-primary" id="add-patient-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Register Patient
        </button>` : ''}
      </div>
    </div>
    <div class="table-container">
      <div class="table-toolbar">
        <div class="table-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="form-input" id="patient-search" placeholder="Search by name, ID, cancer type..." />
        </div>
        <div class="table-filters">
          <select class="form-select" id="filter-cancer" style="width:auto;min-width:150px">
            <option value="">All Cancer Types</option>
            <option value="Lung Cancer">Lung Cancer</option>
            <option value="Breast Cancer">Breast Cancer</option>
            <option value="Colorectal Cancer">Colorectal Cancer</option>
            <option value="Prostate Cancer">Prostate Cancer</option>
            <option value="Ovarian Cancer">Ovarian Cancer</option>
            <option value="Cervical Cancer">Cervical Cancer</option>
            <option value="Head and Neck Cancer">Head & Neck</option>
            <option value="Leukemia">Leukemia</option>
            <option value="Lymphoma">Lymphoma</option>
            <option value="Thyroid Cancer">Thyroid Cancer</option>
            <option value="Stomach Cancer">Stomach Cancer</option>
            <option value="Liver Cancer">Liver Cancer</option>
            <option value="Pancreatic Cancer">Pancreatic Cancer</option>
          </select>
        </div>
      </div>
      <div id="patients-table-body">${Array(8).fill('<div class="skeleton skeleton-row"></div>').join('')}</div>
      <div class="table-pagination" id="patients-pagination"></div>
    </div>
  `;

  // Event listeners
  let searchTimeout;
  document.getElementById('patient-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { currentPage = 1; loadPatients(); }, 300);
  });
  document.getElementById('filter-cancer')?.addEventListener('change', () => { currentPage = 1; loadPatients(); });
  document.getElementById('add-patient-btn')?.addEventListener('click', () => showPatientForm());

  // CSV Export handler
  document.getElementById('export-patients-btn')?.addEventListener('click', async () => {
    const sb = getSupabase();
    showToast('Preparing CSV export...', 'info');
    try {
      const { data, error } = await sb.from('patients').select('*').eq('is_active', true).order('created_at', { ascending: false });
      if (error) throw error;
      exportToCSV(data, 'patients_export', [
        { label: 'Patient ID', key: 'patient_code' },
        { label: 'Name', key: 'full_name' },
        { label: 'Age', key: 'age' },
        { label: 'Gender', key: 'gender' },
        { label: 'State', key: 'state' },
        { label: 'City', key: 'city' },
        { label: 'Cancer Type', key: 'cancer_type' },
        { label: 'Cancer Stage', key: 'cancer_stage' },
        { label: 'Diagnosis Date', key: 'diagnosis_date' },
        { label: 'Treating Hospital', key: 'treating_hospital' },
        { label: 'Insurance', key: 'insurance_status' },
        { label: 'Economic Status', key: 'economic_status' },
        { label: 'Consent Given', accessor: r => r.consent_given ? 'Yes' : 'No' },
        { label: 'Consent Date', key: 'consent_date' },
        { label: 'Consent Method', key: 'consent_method' },
        { label: 'Registered', key: 'created_at' },
      ]);
      showToast(`Exported ${data.length} patients to CSV`, 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });

  await loadPatients();
}

async function loadPatients() {
  const sb = getSupabase();
  const search = document.getElementById('patient-search')?.value || '';
  const cancerFilter = document.getElementById('filter-cancer')?.value || '';
  const tableBody = document.getElementById('patients-table-body');

  try {
    let query = sb.from('patients').select('*, profiles:created_by(full_name)', { count: 'exact' })
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1);

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,patient_code.ilike.%${search}%,cancer_type.ilike.%${search}%,city.ilike.%${search}%`);
    }
    if (cancerFilter) {
      query = query.eq('cancer_type', cancerFilter);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      tableBody.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><h3>No patients found</h3><p>Register a new patient to get started.</p></div>';
      return;
    }

    tableBody.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Patient ID</th>
          <th>Name</th>
          <th>Age/Gender</th>
          <th>Cancer Type</th>
          <th>Stage</th>
          <th>Location</th>
          <th>Consent</th>
          <th>Registered</th>
          <th>Actions</th>
        </tr></thead>
        <tbody>
          ${data.map(p => `
            <tr class="animate-fade-in" style="cursor:pointer" data-patient-id="${p.id}">
              <td><strong class="text-primary">${sanitize(p.patient_code)}</strong></td>
              <td>${sanitize(p.full_name)}</td>
              <td>${p.age || '—'} / ${capitalize(p.gender)}</td>
              <td>${sanitize(p.cancer_type) || '—'}</td>
              <td><span class="badge badge-neutral">${capitalize(p.cancer_stage)}</span></td>
              <td>${sanitize(p.city || '')}${p.state ? ', ' + sanitize(p.state) : ''}</td>
              <td>${p.consent_given ? '<span class="badge badge-success badge-dot">Yes</span>' : '<span class="badge badge-danger badge-dot">No</span>'}</td>
              <td>${formatDate(p.created_at)}</td>
              <td>
                <button class="btn btn-ghost btn-sm view-patient-btn" data-id="${p.id}" title="View details">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Click handlers
    tableBody.querySelectorAll('.view-patient-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('patients/' + btn.dataset.id);
      });
    });
    tableBody.querySelectorAll('tr[data-patient-id]').forEach(row => {
      row.addEventListener('click', () => navigate('patients/' + row.dataset.patientId));
    });

    // Pagination
    const totalPages = Math.ceil((count || 0) / PAGE_SIZE);
    const pagination = document.getElementById('patients-pagination');
    if (pagination) {
      pagination.innerHTML = `
        <span>Showing ${(currentPage-1)*PAGE_SIZE + 1}–${Math.min(currentPage*PAGE_SIZE, count)} of ${count}</span>
        <div class="page-buttons">
          <button class="btn btn-ghost btn-sm" ${currentPage <= 1 ? 'disabled' : ''} id="prev-page-btn">← Prev</button>
          <button class="btn btn-ghost btn-sm" ${currentPage >= totalPages ? 'disabled' : ''} id="next-page-btn">Next →</button>
        </div>
      `;
      document.getElementById('prev-page-btn')?.addEventListener('click', () => { currentPage--; loadPatients(); });
      document.getElementById('next-page-btn')?.addEventListener('click', () => { currentPage++; loadPatients(); });
    }
  } catch (err) {
    console.error('Load patients error:', err);
    showToast('Failed to load patients: ' + err.message, 'error');
  }
}

function showPatientForm(existing = null) {
  const isEdit = !!existing;
  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <div class="consent-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <p><strong>DPDPA Compliance:</strong> Patient consent must be obtained before recording any personal data. Ensure the patient has been informed about data collection purposes.</p>
    </div>
    <form id="patient-form">
      <h4 style="margin-bottom:var(--space-4)">Consent</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" id="pf-consent" ${existing?.consent_given ? 'checked' : ''} required />
            <span>Patient has given informed consent <span class="required">*</span></span>
          </label>
        </div>
        <div class="form-group">
          <label class="form-label">Consent Method <span class="required">*</span></label>
          <select class="form-select" id="pf-consent-method">
            <option value="verbal_during_call" ${existing?.consent_method === 'verbal_during_call' ? 'selected' : ''}>Verbal During Call</option>
            <option value="written" ${existing?.consent_method === 'written' ? 'selected' : ''}>Written</option>
            <option value="digital" ${existing?.consent_method === 'digital' ? 'selected' : ''}>Digital</option>
            <option value="guardian_consent" ${existing?.consent_method === 'guardian_consent' ? 'selected' : ''}>Guardian Consent</option>
          </select>
        </div>
      </div>

      <h4 style="margin-bottom:var(--space-4);margin-top:var(--space-4)">Personal Information</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Full Name <span class="required">*</span></label>
          <input class="form-input" id="pf-name" value="${sanitize(existing?.full_name || '')}" placeholder="Patient's full name" required />
        </div>
        <div class="form-group">
          <label class="form-label">Age</label>
          <input class="form-input" id="pf-age" type="number" min="0" max="150" value="${existing?.age || ''}" placeholder="Age" />
        </div>
        <div class="form-group">
          <label class="form-label">Gender</label>
          <select class="form-select" id="pf-gender">
            <option value="prefer_not_to_say" ${existing?.gender === 'prefer_not_to_say' ? 'selected' : ''}>Prefer not to say</option>
            <option value="male" ${existing?.gender === 'male' ? 'selected' : ''}>Male</option>
            <option value="female" ${existing?.gender === 'female' ? 'selected' : ''}>Female</option>
            <option value="other" ${existing?.gender === 'other' ? 'selected' : ''}>Other</option>
          </select>
        </div>
      </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Phone (last 4 digits for masking)</label>
          <input class="form-input" id="pf-phone" value="${sanitize(existing?.phone_masked || '')}" placeholder="e.g., 8734" maxlength="4" />
        </div>
        <div class="form-group">
          <label class="form-label">State</label>
          <input class="form-input" id="pf-state" value="${sanitize(existing?.state || '')}" placeholder="e.g., Maharashtra" />
        </div>
        <div class="form-group">
          <label class="form-label">City</label>
          <input class="form-input" id="pf-city" value="${sanitize(existing?.city || '')}" placeholder="e.g., Mumbai" />
        </div>
      </div>
      
      <h4 style="margin-bottom:var(--space-4);margin-top:var(--space-4)">Caregiver Information</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Caregiver Name</label>
          <input class="form-input" id="pf-caregiver-name" value="${sanitize(existing?.caregiver_name || '')}" placeholder="Caregiver's name" />
        </div>
        <div class="form-group">
          <label class="form-label">Relationship</label>
          <input class="form-input" id="pf-caregiver-rel" value="${sanitize(existing?.caregiver_relationship || '')}" placeholder="e.g., Son, Wife" />
        </div>
        <div class="form-group">
          <label class="form-label">Caregiver Phone (Last 4)</label>
          <input class="form-input" id="pf-caregiver-phone" value="${sanitize(existing?.caregiver_phone_masked || '')}" placeholder="e.g., 1234" maxlength="4" />
        </div>
      </div>

      <h4 style="margin-bottom:var(--space-4);margin-top:var(--space-4)">Medical Information</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Cancer Type</label>
          <input class="form-input" id="pf-cancer-type" value="${sanitize(existing?.cancer_type || '')}" placeholder="e.g., Breast Cancer" />
        </div>
        <div class="form-group">
          <label class="form-label">Cancer Stage</label>
          <select class="form-select" id="pf-cancer-stage">
            <option value="unknown" ${existing?.cancer_stage === 'unknown' ? 'selected' : ''}>Unknown</option>
            <option value="stage_i" ${existing?.cancer_stage === 'stage_i' ? 'selected' : ''}>Stage I</option>
            <option value="stage_ii" ${existing?.cancer_stage === 'stage_ii' ? 'selected' : ''}>Stage II</option>
            <option value="stage_iii" ${existing?.cancer_stage === 'stage_iii' ? 'selected' : ''}>Stage III</option>
            <option value="stage_iv" ${existing?.cancer_stage === 'stage_iv' ? 'selected' : ''}>Stage IV</option>
            <option value="not_applicable" ${existing?.cancer_stage === 'not_applicable' ? 'selected' : ''}>Not Applicable</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Diagnosis Date</label>
          <input class="form-input" id="pf-diagnosis-date" type="date" value="${existing?.diagnosis_date || ''}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Current Treatment</label>
          <input class="form-input" id="pf-treatment" value="${sanitize(existing?.current_treatment || '')}" placeholder="e.g., Chemotherapy" />
        </div>
        <div class="form-group">
          <label class="form-checkbox" style="margin-top: 2rem;">
            <input type="checkbox" id="pf-clinical-trial" ${existing?.clinical_trial_aware ? 'checked' : ''} />
            <span>Aware of Clinical Trials</span>
          </label>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Treating Hospital</label>
          <input class="form-input" id="pf-hospital" value="${sanitize(existing?.treating_hospital || '')}" placeholder="Hospital name" />
        </div>
        <div class="form-group">
          <label class="form-label">Insurance Status</label>
          <select class="form-select" id="pf-insurance">
            <option value="unknown" ${existing?.insurance_status === 'unknown' ? 'selected' : ''}>Unknown</option>
            <option value="insured" ${existing?.insurance_status === 'insured' ? 'selected' : ''}>Insured</option>
            <option value="uninsured" ${existing?.insurance_status === 'uninsured' ? 'selected' : ''}>Uninsured</option>
            <option value="govt_scheme" ${existing?.insurance_status === 'govt_scheme' ? 'selected' : ''}>Government Scheme</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Payment Method</label>
          <input class="form-input" id="pf-payment" value="${sanitize(existing?.payment_method || '')}" placeholder="e.g., PMYojna, Self" />
        </div>
        <div class="form-group">
          <label class="form-label">Economic Status</label>
          <select class="form-select" id="pf-economic">
            <option value="unknown" ${existing?.economic_status === 'unknown' ? 'selected' : ''}>Unknown</option>
            <option value="bpl" ${existing?.economic_status === 'bpl' ? 'selected' : ''}>Below Poverty Line</option>
            <option value="lower_middle" ${existing?.economic_status === 'lower_middle' ? 'selected' : ''}>Lower Middle</option>
            <option value="middle" ${existing?.economic_status === 'middle' ? 'selected' : ''}>Middle</option>
            <option value="upper_middle" ${existing?.economic_status === 'upper_middle' ? 'selected' : ''}>Upper Middle</option>
          </select>
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="pf-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="pf-submit">
          ${isEdit ? 'Update Patient' : 'Register Patient'}
        </button>
      </div>
    </form>
  `;

  const modal = showModal({
    title: isEdit ? 'Edit Patient' : 'Register New Patient',
    content: formContent,
    size: 'xl',
  });

  // Cancel button
  formContent.querySelector('#pf-cancel').addEventListener('click', closeModal);

  // Form submit
  formContent.querySelector('#patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const consent = formContent.querySelector('#pf-consent').checked;
    if (!consent) { showToast('Patient consent is required (DPDPA)', 'warning'); return; }
    const name = formContent.querySelector('#pf-name').value.trim();
    if (!name) { showToast('Patient name is required', 'warning'); return; }

    const patientData = {
      full_name: name,
      age: parseInt(formContent.querySelector('#pf-age').value) || null,
      gender: formContent.querySelector('#pf-gender').value,
      phone_masked: formContent.querySelector('#pf-phone').value ? 'XXXXX-X' + formContent.querySelector('#pf-phone').value : null,
      state: formContent.querySelector('#pf-state').value || null,
      city: formContent.querySelector('#pf-city').value || null,
      caregiver_name: formContent.querySelector('#pf-caregiver-name').value || null,
      caregiver_relationship: formContent.querySelector('#pf-caregiver-rel').value || null,
      caregiver_phone_masked: formContent.querySelector('#pf-caregiver-phone').value ? 'XXXXX-X' + formContent.querySelector('#pf-caregiver-phone').value : null,
      cancer_type: formContent.querySelector('#pf-cancer-type').value || null,
      cancer_stage: formContent.querySelector('#pf-cancer-stage').value,
      diagnosis_date: formContent.querySelector('#pf-diagnosis-date').value || null,
      treating_hospital: formContent.querySelector('#pf-hospital').value || null,
      current_treatment: formContent.querySelector('#pf-treatment').value || null,
      clinical_trial_aware: formContent.querySelector('#pf-clinical-trial').checked,
      insurance_status: formContent.querySelector('#pf-insurance').value,
      economic_status: formContent.querySelector('#pf-economic').value,
      payment_method: formContent.querySelector('#pf-payment').value || null,
      consent_given: true,
      consent_date: new Date().toISOString(),
      consent_method: formContent.querySelector('#pf-consent-method').value,
    };

    try {
      const sb = getSupabase();
      const submitBtn = formContent.querySelector('#pf-submit');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="spinner"></div>';

      if (isEdit) {
        const { error } = await sb.from('patients').update(patientData).eq('id', existing.id);
        if (error) throw error;
        showToast('Patient updated successfully', 'success');
      } else {
        patientData.created_by = getCurrentUser().id;
        const { error } = await sb.from('patients').insert(patientData);
        if (error) throw error;
        showToast('Patient registered successfully', 'success');
      }
      closeModal();
      loadPatients();
    } catch (err) {
      console.error('Save patient error:', err);
      showToast('Failed to save patient: ' + err.message, 'error');
      const submitBtn = formContent.querySelector('#pf-submit');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Update Patient' : 'Register Patient'; }
    }
  });
}

async function renderPatientDetail(container, patientId) {
  container.innerHTML = `<div class="card">${Array(6).fill('<div class="skeleton skeleton-text"></div>').join('')}</div>`;

  const sb = getSupabase();
  try {
    const { data: patient, error } = await sb.from('patients')
      .select('*, profiles:created_by(full_name)')
      .eq('id', patientId).single();
    if (error) throw error;

    const { data: calls } = await sb.from('call_logs')
      .select('*, profiles:caller_id(full_name)')
      .eq('patient_id', patientId)
      .order('call_date', { ascending: false });

    container.innerHTML = `
      <div class="page-header">
        <div class="flex items-center gap-4">
          <button class="btn btn-ghost btn-icon" id="back-to-patients">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div>
            <h1>${sanitize(patient.full_name)}</h1>
            <p class="header-subtitle" style="margin:0">${patient.patient_code} • Registered ${formatDate(patient.created_at)}</p>
          </div>
        </div>
        <div class="flex gap-2">
          ${isManagerOrAdmin() ? `<button class="btn btn-secondary" id="edit-patient-btn">Edit Patient</button>` : ''}
        </div>
      </div>

      <div class="content-grid mb-6">
        <div class="col-span-4">
          <div class="card">
            <h4 class="mb-4">Personal Info</h4>
            <div style="display:grid;gap:var(--space-3)">
              <div><span class="text-muted">Age/Gender:</span> <span class="text-primary">${patient.age || '—'} / ${capitalize(patient.gender)}</span></div>
              <div><span class="text-muted">Location:</span> <span class="text-primary">${[patient.city, patient.state].filter(Boolean).join(', ') || '—'}</span></div>
              <div><span class="text-muted">Phone:</span> <span class="text-primary">${patient.phone_masked || '—'}</span></div>
              <div><span class="text-muted">Insurance:</span> ${capitalize(patient.insurance_status)}</div>
              <div><span class="text-muted">Economic:</span> ${capitalize(patient.economic_status)}</div>
            </div>
          </div>
        </div>
        <div class="col-span-4">
          <div class="card">
            <h4 class="mb-4">Medical Info</h4>
            <div style="display:grid;gap:var(--space-3)">
              <div><span class="text-muted">Cancer Type:</span> <strong class="text-primary">${sanitize(patient.cancer_type) || '—'}</strong></div>
              <div><span class="text-muted">Stage:</span> <span class="badge badge-neutral">${capitalize(patient.cancer_stage)}</span></div>
              <div><span class="text-muted">Treatment:</span> ${sanitize(patient.current_treatment) || '—'}</div>
              <div><span class="text-muted">Diagnosed:</span> ${formatDate(patient.diagnosis_date)}</div>
              <div><span class="text-muted">Hospital:</span> ${sanitize(patient.treating_hospital) || '—'}</div>
              <div><span class="text-muted">Trials Aware:</span> ${patient.clinical_trial_aware ? 'Yes' : 'No'}</div>
              <div><span class="text-muted">Payment:</span> ${sanitize(patient.payment_method) || '—'}</div>
            </div>
          </div>
        </div>
        <div class="col-span-4">
          <div class="card">
            <h4 class="mb-4">Caregiver & Compliance</h4>
            <div style="display:grid;gap:var(--space-3)">
              <div><span class="text-muted">Caregiver:</span> ${sanitize(patient.caregiver_name) || '—'} ${patient.caregiver_relationship ? `(${sanitize(patient.caregiver_relationship)})` : ''}</div>
              <div><span class="text-muted">CG Phone:</span> ${patient.caregiver_phone_masked || '—'}</div>
              <div><span class="text-muted">Consent:</span> ${patient.consent_given ? '<span class="badge badge-success badge-dot">Given</span>' : '<span class="badge badge-danger badge-dot">Not Given</span>'}</div>
              <div><span class="text-muted">Method:</span> ${capitalize(patient.consent_method)}</div>
              <div><span class="text-muted">Consent Date:</span> ${formatDate(patient.consent_date)}</div>
              <div><span class="text-muted">Retain Until:</span> ${formatDate(patient.data_retention_until)}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Call History (${(calls || []).length})</div>
          <button class="btn btn-primary btn-sm" id="add-call-btn">+ Log Call</button>
        </div>
        <div id="patient-calls">
          ${!calls || calls.length === 0 ? '<div class="empty-state"><p>No calls logged yet</p></div>' : `
            <table class="data-table">
              <thead><tr><th>Date</th><th>Caller</th><th>Status</th><th>Duration</th><th>Mindset</th><th>Score</th><th>Notes</th></tr></thead>
              <tbody>${calls.map(c => `
                <tr>
                  <td>${formatDate(c.call_date)}</td>
                  <td>${c.profiles?.full_name || '—'}</td>
                  <td>${getDialStatusBadge(c.dial_status)}</td>
                  <td>${c.call_duration_mins || 0} min</td>
                  <td>${c.patient_mindset ? capitalize(c.patient_mindset) : '—'}</td>
                  <td>${c.conversion_score}/10</td>
                  <td title="${sanitize(c.caller_notes || '')}">${sanitize((c.caller_notes || '').slice(0, 50))}${(c.caller_notes || '').length > 50 ? '...' : ''}</td>
                </tr>
              `).join('')}</tbody>
            </table>
          `}
        </div>
      </div>
    `;

    document.getElementById('back-to-patients')?.addEventListener('click', () => navigate('patients'));
    document.getElementById('edit-patient-btn')?.addEventListener('click', () => showPatientForm(patient));
    document.getElementById('add-call-btn')?.addEventListener('click', () => {
      navigate('calls');
      setTimeout(() => document.dispatchEvent(new CustomEvent('open-call-form', { detail: { patientId: patient.id, patientName: patient.full_name } })), 100);
    });
  } catch (err) {
    console.error('Patient detail error:', err);
    showToast('Failed to load patient: ' + err.message, 'error');
    container.innerHTML = '<div class="empty-state"><h3>Patient not found</h3></div>';
  }
}
