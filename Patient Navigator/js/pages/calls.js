// ============================================================
// Patient Navigator — Call Logs Page
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentUser, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { formatDate, formatDateTime, capitalize, getDialStatusBadge, getMindsetBadge, renderScoreBar } from '../utils/formatters.js';
import { sanitize } from '../utils/validators.js';

const PAGE_SIZE = 25;
let currentPage = 1;

export async function renderCalls(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Call Logs</h1>
      <button class="btn btn-primary" id="add-call-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Log New Call
      </button>
    </div>
    <div class="table-container">
      <div class="table-toolbar">
        <div class="table-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="form-input" id="call-search" placeholder="Search by patient code or notes..." />
        </div>
        <div class="table-filters">
          <select class="form-select" id="filter-status" style="width:auto;min-width:140px">
            <option value="">All Statuses</option>
            <option value="connected">Connected</option>
            <option value="no_answer">No Answer</option>
            <option value="busy">Busy</option>
            <option value="callback_requested">Callback</option>
            <option value="wrong_number">Wrong Number</option>
          </select>
        </div>
      </div>
      <div id="calls-table-body">${Array(8).fill('<div class="skeleton skeleton-row"></div>').join('')}</div>
      <div class="table-pagination" id="calls-pagination"></div>
    </div>
  `;

  let searchTimeout;
  document.getElementById('call-search')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { currentPage = 1; loadCalls(); }, 300);
  });
  document.getElementById('filter-status')?.addEventListener('change', () => { currentPage = 1; loadCalls(); });
  document.getElementById('add-call-btn')?.addEventListener('click', () => showCallForm());

  // Listen for external open-call-form event (from patient detail)
  document.addEventListener('open-call-form', (e) => {
    showCallForm(null, e.detail);
  }, { once: true });

  await loadCalls();
}

async function loadCalls() {
  const sb = getSupabase();
  const search = document.getElementById('call-search')?.value || '';
  const statusFilter = document.getElementById('filter-status')?.value || '';
  const tableBody = document.getElementById('calls-table-body');

  try {
    let query = sb.from('call_logs')
      .select('*, patients(patient_code, full_name, cancer_type), profiles:caller_id(full_name), reviewer:qa_reviewer_id(full_name)', { count: 'exact' })
      .order('call_date', { ascending: false })
      .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1);

    if (statusFilter) query = query.eq('dial_status', statusFilter);

    const { data, count, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      tableBody.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3"/></svg><h3>No call logs found</h3><p>Log your first call to get started.</p></div>';
      return;
    }

    tableBody.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Date</th><th>Patient</th><th>Caller</th><th>Status</th><th>Duration</th><th>Mindset</th><th>Score</th><th>Follow-up</th><th>QA</th>
        </tr></thead>
        <tbody>
          ${data.map(c => `
            <tr class="animate-fade-in">
              <td>${formatDate(c.call_date)}</td>
              <td><strong class="text-primary">${c.patients?.patient_code || '—'}</strong><br><small class="text-muted">${sanitize(c.patients?.full_name || '')}</small></td>
              <td>${c.profiles?.full_name || '—'}</td>
              <td>${getDialStatusBadge(c.dial_status)}</td>
              <td>${c.call_duration_mins || 0} min</td>
              <td>${c.patient_mindset ? getMindsetBadge(c.patient_mindset) : '—'}</td>
              <td>${renderScoreBar(c.conversion_score)}</td>
              <td>${c.follow_up_date ? formatDate(c.follow_up_date) : '—'}</td>
              <td>${c.qa_reviewed ? '<span class="badge badge-success">Reviewed</span>' : '<span class="badge badge-warning">Pending</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Pagination
    const totalPages = Math.ceil((count || 0) / PAGE_SIZE);
    const pagination = document.getElementById('calls-pagination');
    if (pagination) {
      pagination.innerHTML = `
        <span>Showing ${(currentPage-1)*PAGE_SIZE + 1}–${Math.min(currentPage*PAGE_SIZE, count)} of ${count}</span>
        <div class="page-buttons">
          <button class="btn btn-ghost btn-sm" ${currentPage <= 1 ? 'disabled' : ''} id="calls-prev">← Prev</button>
          <button class="btn btn-ghost btn-sm" ${currentPage >= totalPages ? 'disabled' : ''} id="calls-next">Next →</button>
        </div>
      `;
      document.getElementById('calls-prev')?.addEventListener('click', () => { currentPage--; loadCalls(); });
      document.getElementById('calls-next')?.addEventListener('click', () => { currentPage++; loadCalls(); });
    }
  } catch (err) {
    console.error('Load calls error:', err);
    showToast('Failed to load calls: ' + err.message, 'error');
  }
}

async function showCallForm(existing = null, prefill = {}) {
  // Load patients for dropdown
  const sb = getSupabase();
  let patients = [];
  try {
    const { data } = await sb.from('patients').select('id, patient_code, full_name').eq('is_active', true).order('full_name');
    patients = data || [];
  } catch (e) { /* fallback to empty */ }

  const isEdit = !!existing;
  const formContent = document.createElement('div');
  formContent.innerHTML = `
    <form id="call-form">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Patient <span class="required">*</span></label>
          <select class="form-select" id="cf-patient" required>
            <option value="">Select patient...</option>
            ${patients.map(p => `<option value="${p.id}" ${(existing?.patient_id || prefill.patientId) === p.id ? 'selected' : ''}>${p.patient_code} — ${sanitize(p.full_name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Call Date</label>
          <input class="form-input" id="cf-date" type="datetime-local" value="${existing?.call_date ? new Date(existing.call_date).toISOString().slice(0,16) : new Date().toISOString().slice(0,16)}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Dial Status <span class="required">*</span></label>
          <select class="form-select" id="cf-status" required>
            <option value="connected" ${existing?.dial_status === 'connected' ? 'selected' : ''}>Connected</option>
            <option value="no_answer" ${(!existing || existing?.dial_status === 'no_answer') ? 'selected' : ''}>No Answer</option>
            <option value="busy" ${existing?.dial_status === 'busy' ? 'selected' : ''}>Busy</option>
            <option value="callback_requested" ${existing?.dial_status === 'callback_requested' ? 'selected' : ''}>Callback Requested</option>
            <option value="wrong_number" ${existing?.dial_status === 'wrong_number' ? 'selected' : ''}>Wrong Number</option>
            <option value="voicemail" ${existing?.dial_status === 'voicemail' ? 'selected' : ''}>Voicemail</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Duration (minutes)</label>
          <input class="form-input" id="cf-duration" type="number" min="0" step="0.5" value="${existing?.call_duration_mins || 0}" />
        </div>
        <div class="form-group">
          <label class="form-label">Lead Source</label>
          <select class="form-select" id="cf-source">
            <option value="other" ${existing?.lead_source === 'other' ? 'selected' : ''}>Other</option>
            <option value="website" ${existing?.lead_source === 'website' ? 'selected' : ''}>Website</option>
            <option value="referral" ${existing?.lead_source === 'referral' ? 'selected' : ''}>Referral</option>
            <option value="hospital_partner" ${existing?.lead_source === 'hospital_partner' ? 'selected' : ''}>Hospital Partner</option>
            <option value="social_media" ${existing?.lead_source === 'social_media' ? 'selected' : ''}>Social Media</option>
            <option value="whatsapp" ${existing?.lead_source === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
            <option value="helpline" ${existing?.lead_source === 'helpline' ? 'selected' : ''}>Helpline</option>
            <option value="camp" ${existing?.lead_source === 'camp' ? 'selected' : ''}>Camp</option>
            <option value="ngo_partner" ${existing?.lead_source === 'ngo_partner' ? 'selected' : ''}>NGO Partner</option>
          </select>
        </div>
      </div>

      <h4 style="margin:var(--space-4) 0">Patient Engagement</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Patient Mindset</label>
          <select class="form-select" id="cf-mindset">
            <option value="neutral" ${existing?.patient_mindset === 'neutral' ? 'selected' : ''}>Neutral</option>
            <option value="hopeful" ${existing?.patient_mindset === 'hopeful' ? 'selected' : ''}>Hopeful</option>
            <option value="anxious" ${existing?.patient_mindset === 'anxious' ? 'selected' : ''}>Anxious</option>
            <option value="resistant" ${existing?.patient_mindset === 'resistant' ? 'selected' : ''}>Resistant</option>
            <option value="distressed" ${existing?.patient_mindset === 'distressed' ? 'selected' : ''}>Distressed</option>
            <option value="informed" ${existing?.patient_mindset === 'informed' ? 'selected' : ''}>Informed</option>
            <option value="grateful" ${existing?.patient_mindset === 'grateful' ? 'selected' : ''}>Grateful</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Follow-up Date</label>
          <input class="form-input" id="cf-followup" type="date" value="${existing?.follow_up_date || ''}" />
        </div>
        <div class="form-group">
          <label class="form-label">Follow-up Priority</label>
          <select class="form-select" id="cf-priority">
            <option value="medium" ${existing?.follow_up_priority === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="high" ${existing?.follow_up_priority === 'high' ? 'selected' : ''}>High</option>
            <option value="low" ${existing?.follow_up_priority === 'low' ? 'selected' : ''}>Low</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-checkbox"><input type="checkbox" id="cf-pitch" ${existing?.value_pitch_executed ? 'checked' : ''} /> Value Pitch Executed</label></div>
        <div class="form-group"><label class="form-checkbox"><input type="checkbox" id="cf-whatsapp" ${existing?.whatsapp_group_joined ? 'checked' : ''} /> WhatsApp Group Joined</label></div>
        <div class="form-group"><label class="form-checkbox"><input type="checkbox" id="cf-social" ${existing?.social_media_follow ? 'checked' : ''} /> Social Media Follow</label></div>
      </div>

      <div class="form-group">
        <label class="form-label">Caller Notes</label>
        <textarea class="form-input form-textarea" id="cf-notes" placeholder="Notes from the call...">${sanitize(existing?.caller_notes || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Resistance / Concerns</label>
        <textarea class="form-input form-textarea" id="cf-resistance" placeholder="Any resistance or key concerns...">${sanitize(existing?.resistance_reason || '')}</textarea>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="cf-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="cf-submit">${isEdit ? 'Update' : 'Log Call'}</button>
      </div>
    </form>
  `;

  showModal({ title: isEdit ? 'Edit Call Log' : 'Log New Call', content: formContent, size: 'xl' });
  formContent.querySelector('#cf-cancel').addEventListener('click', closeModal);

  formContent.querySelector('#call-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patientId = formContent.querySelector('#cf-patient').value;
    if (!patientId) { showToast('Please select a patient', 'warning'); return; }

    const callData = {
      patient_id: patientId,
      caller_id: getCurrentUser().id,
      call_date: formContent.querySelector('#cf-date').value || new Date().toISOString(),
      lead_source: formContent.querySelector('#cf-source').value,
      dial_status: formContent.querySelector('#cf-status').value,
      call_duration_mins: parseFloat(formContent.querySelector('#cf-duration').value) || 0,
      patient_mindset: formContent.querySelector('#cf-mindset').value,
      value_pitch_executed: formContent.querySelector('#cf-pitch').checked,
      whatsapp_group_joined: formContent.querySelector('#cf-whatsapp').checked,
      social_media_follow: formContent.querySelector('#cf-social').checked,
      follow_up_date: formContent.querySelector('#cf-followup').value || null,
      follow_up_priority: formContent.querySelector('#cf-priority').value,
      caller_notes: formContent.querySelector('#cf-notes').value || null,
      resistance_reason: formContent.querySelector('#cf-resistance').value || null,
    };

    try {
      const submitBtn = formContent.querySelector('#cf-submit');
      submitBtn.disabled = true; submitBtn.innerHTML = '<div class="spinner"></div>';
      if (isEdit) {
        const { error } = await sb.from('call_logs').update(callData).eq('id', existing.id);
        if (error) throw error;
        showToast('Call log updated', 'success');
      } else {
        const { error } = await sb.from('call_logs').insert(callData);
        if (error) throw error;
        showToast('Call logged successfully', 'success');
      }
      closeModal();
      loadCalls();
    } catch (err) {
      console.error('Save call error:', err);
      showToast('Failed: ' + err.message, 'error');
      const btn = formContent.querySelector('#cf-submit');
      if (btn) { btn.disabled = false; btn.textContent = isEdit ? 'Update' : 'Log Call'; }
    }
  });
}
