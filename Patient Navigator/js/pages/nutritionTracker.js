import { getSupabase } from '../supabase.js';
import { getCurrentUser, getUserRole, isManagerOrAdmin, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { openNutritionRequest, NUTRITION_REASONS } from '../components/nutritionRequest.js';
import { openNutritionPlanOutcome, openNutritionRequestHistory, PLAN_ATTEMPT_REASONS } from '../components/nutritionPlanOutcome.js';
import { mountCareNotifications } from '../components/careNotifications.js';
import * as nutritionCare from '../components/nutritionCare.js';

const trackerMounts = new WeakMap();

const STAGES = { open: 'Open', assigned: 'Assigned', called: 'Called', plan_shared: 'Completion needs confirmation', closed: 'Closed' };
const OVERDUE = { assignment: 'Assignment overdue', call: 'First call overdue', plan: 'Plan overdue' };

export async function renderNutritionTracker(container) {
  const token = {}; trackerMounts.set(container, token);
  container.innerHTML = `<div class="nw-tracker"><div class="page-header"><div><h1>Nutrition tracker</h1><p class="header-subtitle">Follow each request from the raised need to the nutrition plan.</p></div><div class="nw-actions"><button type="button" class="btn btn-secondary" data-tracker-refresh>Refresh</button>${isManagerOrAdmin() ? '<button type="button" class="btn btn-secondary" data-tracker-settings>Overdue settings</button>' : ''}</div></div><div data-tracker-notifications></div><div data-tracker-content></div></div>`;
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
  let ownerFilter = '';
  let filterNotice = '';
  let search = '';
  let showClosed = false;
  let generation = 0;
  let initialHighlight = true;
  let focusAfterSave = null;
  const highlighted = new URLSearchParams(window.location.hash.split('?')[1] || '').get('request');
  const current = () => !!userId && trackerMounts.get(container) === token && mount.isConnected && getCurrentUser()?.id === userId && !isImpersonating();
  const notificationHandle = mountCareNotifications(container.querySelector('[data-tracker-notifications]'));
  async function refreshAll() {
    if (!current()) return;
    await Promise.all([load(), notificationHandle.then(handle => handle?.refresh())]);
  }
  async function load() {
    if (!current()) return;
    const thisGeneration = ++generation;
    mount.innerHTML = '<div class="card"><p role="status">Loading nutrition requests...</p></div>';
    try {
      const [requestResult, settingsResult] = await Promise.all([
        getSupabase().rpc('get_nutrition_tracker'), getSupabase().rpc('get_nutrition_settings'),
      ]);
      if (!current() || thisGeneration !== generation) return;
      if (requestResult.error) throw requestResult.error;
      if (settingsResult.error) throw settingsResult.error;
      if (!Array.isArray(requestResult.data)) throw new Error('unavailable');
      requests = requestResult.data;
      if (ownerFilter && ownerFilter !== '__unassigned__' && !requests.some(row => row.owner_id === ownerFilter)) {
        ownerFilter = ''; filterNotice = 'That intern no longer has requests in this view. Showing all interns.';
      }
      settings = settingsResult.data;
      const focused = requests.find(row => row.id === (focusAfterSave || (initialHighlight ? highlighted : null)));
      if (focused) showClosed = focused.status === 'closed' && !(focused.pending_followups || []).length;
      focusAfterSave = null;
      paint();
    } catch (error) {
      if (!current() || thisGeneration !== generation) return;
      mount.innerHTML = `<div class="card"><h3>Could not load nutrition tracker</h3><p class="nw-error" role="alert">Please try again.</p><button type="button" class="btn btn-secondary" data-tracker-retry>Retry</button></div>`;
      mount.querySelector('[data-tracker-retry]').addEventListener('click', load);
    }
  }
  function visibleRows() {
    return requests.filter(row => {
      if ((row.status === 'closed' && !(row.pending_followups || []).length) !== showClosed) return false;
      if (filter === 'mine' && !row.is_mine) return false;
      if (filter === 'overdue' && !row.overdue_stage && !(row.pending_followups || []).some(x => x.overdue)) return false;
      if (filter === 'unassigned' && row.owner_id) return false;
      if (pod && row.pod !== pod) return false;
      if (ownerFilter === '__unassigned__' ? !!row.owner_id : ownerFilter && row.owner_id !== ownerFilter) return false;
      return !search || [row.patient_name, row.raised_by_name, row.owner_name, row.note, NUTRITION_REASONS[row.reason], PLAN_ATTEMPT_REASONS[row.latest_attempt?.reason], row.latest_attempt?.note].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase().trim());
    });
  }
  function paint() {
    if (!current()) return;
    const open = requests.filter(row => row.status !== 'closed' || (row.pending_followups || []).length);
    const pods = [...new Set(requests.map(row => row.pod).filter(Boolean))].sort();
    const owners = [...new Map(requests.filter(row => row.owner_id).map(row => [row.owner_id, row.owner_name || 'Nutrition intern'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    mount.innerHTML = `<div class="card nw-tracker-controls"><div class="nw-section-head"><div class="chip-row" data-tracker-filters>${[['all', 'All open', open.length], ['mine', 'Mine', open.filter(row => row.is_mine).length], ['overdue', 'Overdue', open.filter(row => row.overdue_stage || (row.pending_followups || []).some(x => x.overdue)).length], ['unassigned', 'Unassigned', open.filter(row => !row.owner_id).length]].map(([key, label, count]) => `<button type="button" class="fchip ${filter === key ? 'on' : ''}" data-tracker-filter="${key}">${label} - ${count}</button>`).join('')}</div><label class="nw-closed-toggle"><input type="checkbox" data-tracker-closed ${showClosed ? 'checked' : ''}> Closed requests</label></div><div class="nw-filter-inputs">${isManagerOrAdmin() ? `<div><label class="form-label" for="tracker-owner">Intern</label><select id="tracker-owner" class="form-select"><option value="">All interns</option><option value="__unassigned__" ${ownerFilter === '__unassigned__' ? 'selected' : ''}>Unassigned</option>${owners.map(([id, name]) => `<option value="${sanitize(id)}" ${ownerFilter === id ? 'selected' : ''}>${sanitize(name)}</option>`).join('')}</select><span class="nw-muted">Interns with accessible requests, including closed history.</span></div>` : ''}<div><label class="form-label" for="tracker-pod">Raised by pod</label><select id="tracker-pod" class="form-select"><option value="">All pods</option>${pods.map(value => `<option value="${sanitize(value)}" ${pod === value ? 'selected' : ''}>${sanitize(value)}</option>`).join('')}</select></div><div><label class="form-label" for="tracker-search">Find a request</label><input type="search" class="form-input" id="tracker-search" value="${sanitize(search)}" placeholder="Patient, staff member or note"></div></div>${filterNotice ? `<p class="nw-muted" role="status">${sanitize(filterNotice)}</p>` : ''}<p class="nw-muted">Overdue after ${Number(settings?.assignment_days)} working days for assignment, ${Number(settings?.call_days)} after assignment for the first call, and ${Number(settings?.plan_days)} after that call for the plan. Working days: Monday to Friday, India time. Milestones update from recorded care events.</p></div><div data-tracker-list></div>`;
    mount.querySelectorAll('[data-tracker-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.trackerFilter; showClosed = false; paint(); }));
    mount.querySelector('[data-tracker-closed]').addEventListener('change', event => { showClosed = event.target.checked; filter = 'all'; paint(); });
    mount.querySelector('#tracker-owner')?.addEventListener('change', event => { ownerFilter = event.target.value; filterNotice = ''; paintRows(); });
    mount.querySelector('#tracker-pod').addEventListener('change', event => { pod = event.target.value; paintRows(); });
    mount.querySelector('#tracker-search').addEventListener('input', event => { search = event.target.value; paintRows(); });
    paintRows();
  }
  function paintRows() {
    const list = mount.querySelector('[data-tracker-list]');
    if (!list || !current()) return;
    const shown = visibleRows();
    list.innerHTML = `<p class="nw-muted" role="status">${shown.length} ${showClosed ? 'closed' : 'open'} request${shown.length === 1 ? '' : 's'} shown. Mine includes requests you raised and patients assigned to you.</p>${shown.length ? `<div class="nw-request-head" aria-hidden="true"><span>Patient and need</span><span>Raised</span><span>Assigned</span><span>First call</span><span>Plan shared</span><span>Status</span><span>Actions</span></div><div class="nw-request-list">${shown.map((row, index) => rowHTML(row, index, highlighted)).join('')}</div>` : '<div class="card"><h3>No requests match</h3><p class="nw-muted">Change the filters, or raise a nutrition request from the patient Overview.</p></div>'}`;
    list.querySelectorAll('[data-request-index]').forEach(item => {
      const row = shown[Number(item.dataset.requestIndex)];
      item.querySelector('[data-request-raise]')?.addEventListener('click', () => openNutritionRequest({ patient: { id: row.patient_id, full_name: row.patient_name }, onSaved: load }));
      item.querySelector('[data-request-close]')?.addEventListener('click', () => closeRequest(row));
      item.querySelector('[data-request-plan]')?.addEventListener('click', () => outcome(row, true));
      item.querySelector('[data-request-attempt]')?.addEventListener('click', () => outcome(row, false));
      item.querySelector('[data-request-history]')?.addEventListener('click', () => openNutritionRequestHistory({ row, isCurrent: current }));
      item.querySelector('[data-request-call-link]')?.addEventListener('click', () => nutritionCare.openNutritionCallHistoryLink({ row, isCurrent: current, onSaved: async () => { focusAfterSave = row.id; await refreshAll(); } }));
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
  function outcome(row, shared) {
    openNutritionPlanOutcome({ row, shared, isCurrent: () => current() && (isManagerOrAdmin() || getUserRole() === 'nutritionist'), onSaved: async data => {
      if (!current()) return;
      focusAfterSave = row.id; filter = 'all';
      await refreshAll();
    } });
  }
  function closeRequest(row) {
    nutritionCare.openNutritionResolution({ row, isCurrent: current, onSaved: async () => { focusAfterSave = row.id; filter = 'all'; await refreshAll(); } });
  }
  container.querySelector('[data-tracker-refresh]').addEventListener('click', refreshAll);
  container.querySelector('[data-tracker-settings]')?.addEventListener('click', () => openSettings(settings, refreshAll, current));
  await Promise.all([load(), notificationHandle]);
  return { refresh: refreshAll };
}

function rowHTML(row, index, highlighted) {
  const state = STAGES[row.status] || 'Open';
  const overdue = OVERDUE[row.overdue_stage] || ((row.pending_followups || []).some(x => x.overdue) ? 'Scheduled follow-up overdue' : '');
  return `<article class="card nw-request-row ${row.id === highlighted ? 'is-highlighted' : ''}" data-request-index="${index}" data-request-id="${sanitize(row.id)}" tabindex="-1">
    <div class="nw-request-patient"><a href="#patients/${encodeURIComponent(row.patient_id)}">${sanitize(row.patient_name || 'Patient')}</a><strong>${sanitize(NUTRITION_REASONS[row.reason] || 'Nutrition support')}</strong>${row.note ? `<p>${sanitize(row.note)}</p>` : ''}${row.latest_attempt ? `<div class="nw-latest-attempt"><strong>Latest attempt: ${sanitize(PLAN_ATTEMPT_REASONS[row.latest_attempt.reason] || 'Recorded attempt')}</strong><span class="nw-muted">${sanitize(dateLabel(row.latest_attempt.created_at))} - ${sanitize(row.latest_attempt.actor_name || 'Care team')}</span>${row.latest_attempt.note ? `<p class="nw-private-note">${sanitize(row.latest_attempt.note)}</p>` : ''}</div>` : ''}<span class="nw-muted">${sanitize(row.pod || 'Care')} pod</span></div>
    <div data-step="Raised">${row.source === 'legacy_support_flag' ? '<span class="nw-muted">Support recorded. Original request time unknown.</span>' : ''}${stamp(row.raised_at)}<span class="nw-muted">${sanitize(row.raised_by_name || 'Care team')}</span></div>
    <div data-step="Assigned">${!row.assigned_at && row.owner_id ? '<span class="nw-muted">Time unknown</span>' : stamp(row.assigned_at)}<span class="nw-muted">${sanitize(row.owner_name || 'Unassigned')}</span>${!row.owner_id && !row.assigned_at ? due(row.assignment_due_at) : ''}</div>
    <div data-step="First call">${stamp(row.first_call_at)}${row.latest_nutrition_call_at ? `<span class="nw-muted">Latest linked completed call</span>${stamp(row.latest_nutrition_call_at)}` : ''}${(row.pending_followups || []).map(x => `<span class="nw-muted">Scheduled follow-up due ${sanitize(x.due_on)}</span>`).join('')}${row.assigned_at && !row.first_call_at ? due(row.call_due_at) : ''}</div>
    <div data-step="Plan shared">${planStamp(row)}${row.first_call_at && !row.plan_shared_on && !row.plan_shared_at ? due(row.plan_due_at) : ''}</div>
    <div data-step="Status"><span class="badge badge-${overdue ? 'danger' : row.status === 'closed' ? 'neutral' : 'ok'}">${sanitize(state)}</span>${overdue ? `<strong class="nw-error">${overdue}</strong>` : ''}${row.close_reason ? `<span class="nw-muted">${sanitize({ plan_shared: 'Closed after qualifying plan sharing', completed: 'Closed manually', patient_deceased: 'Closed - patient deceased', patient_inactive: 'Closed - patient inactive' }[row.close_reason] || 'Closed')}</span>` : ''}${row.latest_resolution ? `<span class="nw-muted">${sanitize(nutritionCare.RESOLUTION_REASONS[row.latest_resolution.reason] || 'Documented resolution')}</span><p class="nw-private-note">${sanitize(row.latest_resolution.note || '')}</p>` : ''}${row.closed_at ? stamp(row.closed_at) : ''}</div>
    <div class="nw-row-actions"><button type="button" class="btn btn-secondary btn-sm" data-request-raise>Raise again</button>${row.status !== 'closed' && row.can_record_plan_outcome === true ? '<button type="button" class="btn btn-secondary btn-sm" data-request-plan>Record plan shared</button><button type="button" class="btn btn-secondary btn-sm" data-request-attempt>Plan not shared</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" data-request-history>History (${Math.max(0, Number(row.action_count) || 0)})</button>${row.can_link_calls ? '<button type="button" class="btn btn-secondary btn-sm" data-request-call-link>Link completed call</button>' : ''}${row.status !== 'closed' && row.can_record_plan_outcome === true ? '<button type="button" class="btn btn-ghost btn-sm" data-request-close>Close request</button>' : ''}</div>
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
      if (!current() || !modal.isCurrentModal() || !isManagerOrAdmin()) return;
      if (error) throw error;
      if (!data?.ok) throw new Error('Settings were not saved. Refresh and try again.');
      modal.closeOwnedModal();
      showToast('Nutrition overdue settings saved.', 'success');
      if (current()) await onSaved();
    } catch (error) {
      if (!current() || !modal.isCurrentModal()) return;
      const message = form.querySelector('[data-settings-error]');
      message.textContent = 'Could not save settings. Please try again.';
      message.hidden = false;
      button.disabled = false;
    }
  });
}
