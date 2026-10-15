// Nutrition requests are separate from ownership and can be raised again in care.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, isImpersonating } from '../auth.js';
import { showModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';

export const NUTRITION_REASONS = {
  diet_plan: 'Diet plan', weight_loss: 'Weight loss',
  eating_difficulty: 'Eating difficulty', other: 'Other',
};

export function openNutritionRequest({ patient, onSaved } = {}) {
  if (!patient?.id || isImpersonating()) return;
  const userId = getCurrentUser()?.id;
  if (!userId) return;
  const modal = showModal({
    title: 'Raise nutrition request',
    content: `<form id="nutrition-request-form" class="nw-form">
      <p>Ask for nutrition support for <strong>${sanitize(patient.full_name || patient.patient_name || 'this patient')}</strong>. Each submission creates a separate request, including for someone already in nutrition care.</p>
      <p class="nw-muted">The current nutritionist receives it. If no nutritionist is assigned, it goes to Unclaimed.</p>
      <div class="form-group"><label class="form-label" for="nutrition-reason">Reason</label>
        <select id="nutrition-reason" class="form-select" required>${Object.entries(NUTRITION_REASONS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="nutrition-note">Note <span id="nutrition-note-rule">(optional)</span></label>
        <textarea id="nutrition-note" class="form-input" rows="4" maxlength="2000" placeholder="What did the patient ask for?"></textarea></div>
      <p id="nutrition-request-error" class="nw-error" role="alert" hidden></p>
      <div class="nw-actions"><button type="button" class="btn btn-secondary" data-request-cancel>Cancel</button><button type="submit" class="btn btn-primary">Raise request</button></div>
    </form>`,
  });
  const form = modal.querySelector('form');
  const reason = form.querySelector('#nutrition-reason');
  const note = form.querySelector('#nutrition-note');
  const errorEl = form.querySelector('#nutrition-request-error');
  form.querySelector('[data-request-cancel]').addEventListener('click', () => modal.closeOwnedModal());
  reason.addEventListener('change', () => {
    note.required = reason.value === 'other';
    form.querySelector('#nutrition-note-rule').textContent = note.required ? '(required for Other)' : '(optional)';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (reason.value === 'other' && !note.value.trim()) {
      errorEl.textContent = 'Add a note describing the nutrition concern.';
      errorEl.hidden = false;
      note.focus();
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = 'Raising request...';
    errorEl.hidden = true;
    try {
      if (getCurrentUser()?.id !== userId || isImpersonating()) throw new Error('Your session changed. Close this form and try again.');
      const { data, error } = await getSupabase().rpc('raise_nutrition_request', {
        p_patient: patient.id, p_reason: reason.value, p_note: note.value.trim() || null,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('The request was not confirmed. Refresh the tracker before trying again.');
      modal.closeOwnedModal();
      showToast('Nutrition request raised. You can follow it in Nutrition tracker.', 'success');
      if (typeof onSaved === 'function') onSaved();
    } catch (error) {
      if (!modal.isCurrentModal()) return;
      errorEl.textContent = 'Could not raise request: ' + (error?.message || 'Please try again.');
      errorEl.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Raise request';
    }
  });
  reason.focus();
}

export async function mountNutritionRequest(mount, patient, { onSaved } = {}) {
  if (!mount || !patient?.id || patient.patient_status === 'deceased' || isImpersonating()) return;
  const userId = getCurrentUser()?.id;
  mount.textContent = '';
  try {
    const { data, error } = await getSupabase().rpc('can_care_for_patient', { p_id: patient.id });
    if (!mount.isConnected || getCurrentUser()?.id !== userId || isImpersonating()) return;
    if (error) throw error;
    if (data !== true) return;
    mount.innerHTML = `<div class="card nw-request-prompt"><div><h3>Nutrition support</h3><p class="nw-muted">Raise a new need, even if a nutritionist is already assigned. Follow assignment, calls and the plan in Nutrition tracker.</p></div><button type="button" class="btn btn-primary" data-raise-nutrition>Raise nutrition request</button><a class="btn btn-secondary" href="#nutrition-tracker">Open tracker</a></div>`;
    mount.querySelector('[data-raise-nutrition]').addEventListener('click', () => openNutritionRequest({ patient, onSaved }));
  } catch (error) {
    if (!mount.isConnected || getCurrentUser()?.id !== userId) return;
    mount.innerHTML = '<p class="nw-error" role="status"></p>';
    mount.firstElementChild.textContent = 'Could not check nutrition request access: ' + (error?.message || 'Refresh to try again.');
  }
}
