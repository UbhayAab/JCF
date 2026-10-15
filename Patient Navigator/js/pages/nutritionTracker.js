import { getSupabase } from '../supabase.js';
import { getCurrentUser, getUserRole, isManagerOrAdmin, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { openNutritionRequest, NUTRITION_REASONS } from '../components/nutritionRequest.js';

const STAGES = { open: 'Open', assigned: 'Assigned', called: 'Called', plan_shared: 'Plan shared', closed: 'Closed' };
const OVERDUE = { assignment: 'Assignment overdue', call: 'First call overdue', plan: 'Plan overdue' };

export async function renderNutritionTracker(container) {
  container.innerHTML = `<div class="nw-tracker"><div class="page-header"><div><h1>Nutrition tracker</h1><p class="header-subtitle">Follow each request from the raised need to the nutrition plan.</p></div><div class="nw-actions"><button type="button" class="btn btn-secondary" data-tracker-refresh>Refresh</button>${isManagerOrAdmin() ? '<button type="button" class="btn btn-secondary" data-tracker-settings>Overdue settings</button>' : ''}</div></div><div data-tracker-content></div></div>`;
  const mount = container.querySelector('[data-tracker-content]');
  if (isImpersonating()) {
    mount.innerHTML = '<div class="card"><p>Exit Open as to view nutrition requests for your signed-in account.</p></div>';
    return;
  }
  const userId = getCurrentUser()?.id;
  let requests = [];
  let settings = null;
  let filter = 'all';
  let pod = '';
  let search = '';
  let showClosed = false;
  let generation = 0;
  let initialHighlight = true;
  const highlighted = new URLSearchParams(window.location.hash.split('?')[1] || '').get('request');
  const current = () => mount.isConnected && getCurrentUser()?.id === userId && !isImpersonating();
  async function load() {
    const thisGeneration = ++generation;
    mount.innerHTML = '<div class="card"><p role="status">Loading nutrition requests...</p></div>';
    try {
      const [requestResult, settingsResult] = await Promise.all([
        getSupabase().rpc('get_nutrition_requests'), getSupabase().rpc('get_nutrition_settings'),
      ]);
      if (!current() || thisGeneration !== generation) return;
      if (requestResult.error) throw requestResult.error;
      if (settingsResult.error) throw settingsResult.error;
      requests = Array.isArray(requestResult.data) ? requestResult.data : [];
      settings = settingsResult.data;
      if (initialHighlight && highlighted) showClosed = requests.find(row => row.id === highlighted)?.status === 'closed';
      paint();
    } catch (error) {
      if (!current() || thisGeneration !== generation) return;
      mount.innerHTML = `<div class="card"><h3>Could not load nutrition tracker</h3><p class="nw-error" role="alert">${sanitize(error?.message || 'Please try again.')}</p><button type="button" class="btn btn-secondary" data-tracker-retry>Retry</button></div>`;
      mount.querySelector('[data-tracker-retry]').addEventListener('click', load);
    }
  }
  function visibleRows() {
    return requests.filter(row => {
      if ((row.status === 'closed') !== showClosed) return false;
      if (filter === 'mine' && !row.is_mine) return false;
      if (filter === 'overdue' && !row.overdue_stage) return false;
      if (filter === 'unassigned' && row.owner_id) return false;
      if (pod && row.pod !== pod) return false;
      return !search || [row.patient_name, row.raised_by_name, row.owner_name, row.note, NUTRITION_REASONS[row.reason]].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase().trim());
    });
  }
  function paint() {
    if (!current()) return;
    const open = requests.filter(row => row.status !== 'closed');
    const pods = [...new Set(requests.map(row => row.pod).filter(Boolean))].sort();
    mount.innerHTML = `<div class="card nw-tracker-controls"><div class="nw-section-head"><div class="chip-row" data-tracker-filters>${[['all', 'All open', open.length], ['mine', 'Mine', open.filter(row => row.is_mine).length], ['overdue', 'Overdue', open.filter(row => row.overdue_stage).length], ['unassigned', 'Unassigned', open.filter(row => !row.owner_id).length]].map(([key, label, count]) => `<button type="button" class="fchip ${filter === key ? 'on' : ''}" data-tracker-filter="${key}">${label} - ${count}</button>`).join('')}</div><label class="nw-closed-toggle"><input type="checkbox" data-tracker-closed ${showClosed ? 'checked' : ''}> Closed requests</label></div><div class="nw-filter-inputs"><div><label class="form-label" for="tracker-pod">Raised by pod</label><select id="tracker-pod" class="form-select"><option value="">All pods</option>${pods.map(value => `<option value="${sanitize(value)}" ${pod === value ? 'selected' : ''}>${sanitize(value)}</option>`).join('')}</select></div><div><label class="form-label" for="tracker-search">Find a request</label><input type="search" class="form-input" id="tracker-search" value="${sanitize(search)}" placeholder="Patient, staff member or note"></div></div><p class="nw-muted">Overdue after ${Number(settings?.assignment_days)} working days for assignment, ${Number(settings?.call_days)} after assignment for the first call, and ${Number(settings?.plan_days)} after that call for the plan. Working days: Monday to Friday, India time. Milestones update from recorded care events.</p></div><div data-tracker-list></div>`;
    mount.querySelectorAll('[data-tracker-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.trackerFilter; showClosed = false; paint(); }));
    mount.querySelector('[data-tracker-closed]').addEventListener('change', event => { showClosed = event.target.checked; filter = 'all'; paint(); });
    mount.querySelector('#tracker-pod').addEventListener('change', event => { pod = event.target.value; paintRows(); });
    mount.querySelector('#tracker-search').addEventListener('input', event => { search = event.target.value; paintRows(); });
    paintRows();
  }
  function paintRows() {
    const list = mount.querySelector('[data-tracker-list]');
    if (!list) return;
    const shown = visibleRows();
    list.innerHTML = `<p class="nw-muted" role="status">${shown.length} ${showClosed ? 'closed' : 'open'} request${shown.length === 1 ? '' : 's'} shown. Mine includes requests you raised and patients assigned to you.</p>${shown.length ? `<div class="nw-request-head" aria-hidden="true"><span>Patient and need</span><span>Raised</span><span>Assigned</span><span>First call</span><span>Plan shared</span><span>Status</span><span>Actions</span></div><div class="nw-request-list">${shown.map((row, index) => rowHTML(row, index, highlighted)).join('')}</div>` : '<div class="card"><h3>No requests match</h3><p class="nw-muted">Change the filters, or raise a nutrition request from the patient Overview.</p></div>'}`;
    list.querySelectorAll('[data-request-index]').forEach(item => {
      const row = shown[Number(item.dataset.requestIndex)];
      item.querySelector('[data-request-raise]')?.addEventListener('click', () => openNutritionRequest({ patient: { id: row.patient_id, full_name: row.patient_name }, onSaved: load }));
      item.querySelector('[data-request-close]')?.addEventListener('click', () => closeRequest(row));
      item.querySelector('[data-request-plan]')?.addEventListener('click', () => recordPlan(row));
    });
    if (initialHighlight && highlighted) {
      initialHighlight = false;
      const item = [...list.querySelectorAll('[data-request-id]')].find(element => element.dataset.requestId === highlighted);
      if (item) { item.scrollIntoView({ block: 'center' }); item.focus({ preventScroll: true }); }
      else {
        const notice = document.createElement('p');
        notice.className = 'nw-muted';
        notice.setAttribute('role', 'status');
        notice.textContent = 'That request is no longer available to your account. The requests you can access are shown below.';
        list.prepend(notice);
      }
    }
  }
  function recordPlan(row) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const modal = showModal({ title: 'Record plan shared', content: `<form id="nutrition-plan-form" class="nw-form"><p>Record a nutrition plan actually shared with <strong>${sanitize(row.patient_name)}</strong>.</p><p class="nw-muted">Use the day it was shared. This records a new sharing event, including a revised plan. An older plan does not complete a newer request.</p><div class="form-group"><label class="form-label" for="nutrition-plan-date">Date shared</label><input type="date" class="form-input" id="nutrition-plan-date" value="${today}" max="${today}" required></div><div class="form-group"><label class="form-label" for="nutrition-plan-note">Note (optional)</label><textarea class="form-input" id="nutrition-plan-note" maxlength="2000" rows="3"></textarea></div><p class="nw-error" data-plan-error role="alert" hidden></p><div class="nw-actions"><button type="button" class="btn btn-secondary" data-plan-cancel>Cancel</button><button type="submit" class="btn btn-primary">Record plan shared</button></div></form>` });
    modal.querySelector('[data-plan-cancel]').onclick = () => modal.closeOwnedModal();
    const form = modal.querySelector('form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (!current() || !(isManagerOrAdmin() || getUserRole() === 'nutritionist')) throw new Error('Your session changed. Refresh and try again.');
        const { data, error } = await getSupabase().rpc('record_service_event', { p_patient_id: row.patient_id, p_lever: 'nutrition_plan_given', p_event: 'offered', p_occurred_on: form.querySelector('#nutrition-plan-date').value, p_note: form.querySelector('#nutrition-plan-note').value.trim() || null });
        if (error) throw error;
        if (!data) throw new Error('The sharing event was not confirmed. Refresh before trying again.');
        modal.closeOwnedModal();
        showToast('Plan sharing recorded. Earlier plans stay in history.', 'success');
        if (current()) await load();
      } catch (error) {
        if (!modal.isCurrentModal()) return;
        const message = form.querySelector('[data-plan-error]');
        message.textContent = error?.message || 'Could not record plan sharing.';
        message.hidden = false; button.disabled = false;
      }
    });
  }
  function closeRequest(row) {
    const modal = showModal({ title: 'Close nutrition request', content: `<p>Close the request for <strong>${sanitize(row.patient_name || 'this patient')}</strong> raised on ${sanitize(dateLabel(row.raised_at))}?</p><p class="nw-muted">Use this when this need is handled or no longer needed. Nutrition ownership stays in place. You can raise a new request later.</p><p class="nw-error" data-close-error role="alert" hidden></p>`, footer: '<button type="button" class="btn btn-secondary" data-close-cancel>Cancel</button><button type="button" class="btn btn-primary" data-close-confirm>Close request</button>' });
    modal.querySelector('[data-close-cancel]').addEventListener('click', () => modal.closeOwnedModal());
    modal.querySelector('[data-close-confirm]').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        if (!current()) throw new Error('Your session changed. Refresh and try again.');
        const { data, error } = await getSupabase().rpc('close_nutrition_request', { p_request: row.id });
        if (error) throw error;
        if (!data?.ok) throw new Error('The request was not closed. Refresh and try again.');
        modal.closeOwnedModal();
        showToast('Nutrition request closed.', 'success');
        if (current()) await load();
      } catch (error) {
        if (!modal.isCurrentModal()) return;
        const message = modal.querySelector('[data-close-error]');
        message.textContent = error?.message || 'Could not close request.';
        message.hidden = false;
        button.disabled = false;
      }
    });
  }
  container.querySelector('[data-tracker-refresh]').addEventListener('click', load);
  container.querySelector('[data-tracker-settings]')?.addEventListener('click', () => openSettings(settings, load, current));
  await load();
}

function rowHTML(row, index, highlighted) {
  const state = STAGES[row.status] || 'Open';
  const overdue = OVERDUE[row.overdue_stage];
  return `<article class="card nw-request-row ${row.id === highlighted ? 'is-highlighted' : ''}" data-request-index="${index}" data-request-id="${sanitize(row.id)}" tabindex="-1">
    <div class="nw-request-patient"><a href="#patients/${encodeURIComponent(row.patient_id)}">${sanitize(row.patient_name || 'Patient')}</a><strong>${sanitize(NUTRITION_REASONS[row.reason] || 'Nutrition support')}</strong>${row.note ? `<p>${sanitize(row.note)}</p>` : ''}<span class="nw-muted">${sanitize(row.pod || 'Care')} pod</span></div>
    <div data-step="Raised">${row.source === 'legacy_support_flag' ? '<span class="nw-muted">Support recorded. Original request time unknown.</span>' : ''}${stamp(row.raised_at)}<span class="nw-muted">${sanitize(row.raised_by_name || 'Care team')}</span></div>
    <div data-step="Assigned">${!row.assigned_at && row.owner_id ? '<span class="nw-muted">Time unknown</span>' : stamp(row.assigned_at)}<span class="nw-muted">${sanitize(row.owner_name || 'Unassigned')}</span>${!row.owner_id && !row.assigned_at ? due(row.assignment_due_at) : ''}</div>
    <div data-step="First call">${stamp(row.first_call_at)}${row.assigned_at && !row.first_call_at ? due(row.call_due_at) : ''}</div>
    <div data-step="Plan shared">${planStamp(row)}${row.first_call_at && !row.plan_shared_on && !row.plan_shared_at ? due(row.plan_due_at) : ''}</div>
    <div data-step="Status"><span class="badge badge-${overdue ? 'danger' : row.status === 'closed' ? 'neutral' : 'ok'}">${sanitize(state)}</span>${overdue ? `<strong class="nw-error">${overdue}</strong>` : ''}${row.closed_at ? stamp(row.closed_at) : ''}</div>
    <div class="nw-row-actions"><button type="button" class="btn btn-secondary btn-sm" data-request-raise>Raise again</button>${row.status !== 'closed' && (isManagerOrAdmin() || getUserRole() === 'nutritionist') ? '<button type="button" class="btn btn-secondary btn-sm" data-request-plan>Record plan shared</button>' : ''}${row.status !== 'closed' ? '<button type="button" class="btn btn-ghost btn-sm" data-request-close>Close request</button>' : ''}</div>
  </article>`;
}
function planStamp(row) {
  if (row.plan_time_precision === 'date' && row.plan_shared_on) {
    const label = new Date(row.plan_shared_on + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    return `<time datetime="${sanitize(row.plan_shared_on)}">Shared on ${sanitize(label)}</time><span class="nw-muted">Date recorded; time unknown</span>`;
  }
  return stamp(row.plan_shared_at);
}
function stamp(value) {
  return value ? `<time datetime="${sanitize(value)}">${sanitize(dateLabel(value))}</time>` : '<span class="nw-muted">Not yet</span>';
}
function due(value) { return value ? `<span class="nw-muted">Due ${sanitize(dateLabel(value))}</span>` : ''; }
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function openSettings(settings, onSaved, current) {
  if (!settings || !isManagerOrAdmin() || !current()) return;
  const modal = showModal({ title: 'Nutrition overdue settings', content: `<form class="nw-form"><p>Set how many working days each step can wait. Monday to Friday, India time. Changes apply to open requests immediately.</p>${[['assignment_days', 'Days from request to assignment'], ['call_days', 'Days from assignment to first call'], ['plan_days', 'Days from first call to plan shared']].map(([key, label]) => `<div class="form-group"><label class="form-label" for="setting-${key}">${label}</label><input id="setting-${key}" name="${key}" class="form-input" type="number" min="1" max="${key === 'plan_days' ? 60 : 30}" step="1" required value="${Number(settings[key])}"></div>`).join('')}<p class="nw-error" data-settings-error role="alert" hidden></p><div class="nw-actions"><button type="button" class="btn btn-secondary" data-settings-cancel>Cancel</button><button type="submit" class="btn btn-primary">Save settings</button></div></form>` });
  const form = modal.querySelector('form');
  form.querySelector('[data-settings-cancel]').addEventListener('click', () => modal.closeOwnedModal());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (!current() || !isManagerOrAdmin()) throw new Error('Your session changed. Refresh and try again.');
      const { data, error } = await getSupabase().rpc('set_nutrition_settings', {
        p_assignment_days: Number(form.elements.assignment_days.value),
        p_call_days: Number(form.elements.call_days.value),
        p_plan_days: Number(form.elements.plan_days.value),
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('Settings were not saved. Refresh and try again.');
      modal.closeOwnedModal();
      showToast('Nutrition overdue settings saved.', 'success');
      if (current()) await onSaved();
    } catch (error) {
      if (!modal.isCurrentModal()) return;
      const message = form.querySelector('[data-settings-error]');
      message.textContent = error?.message || 'Could not save settings.';
      message.hidden = false;
      button.disabled = false;
    }
  });
}
