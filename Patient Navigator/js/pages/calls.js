// ============================================================
// Patient Navigator: Call Logs (v9)
// Honest rapport-model columns (no sales scores): outcome,
// receptiveness, condition, what they asked for, follow-up.
//
// SCOPE: a caller sees the calls she logged. Only those. No switch, no
// wider view. v8 offered a "Show" dropdown defaulting to her own calls;
// that was still one click away from the whole team's history, and the
// ask was for it to simply not be there.
//
// Known cost, accepted deliberately: when a colleague dials for a family
// whose language she speaks and logs it, the mentor who owns that
// patient will not find it on this page. It is still on the patient's
// own record, and managers still see everything.
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin, getCurrentProfile } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { openCallForm } from '../components/callForm.js';
import { formatDate, formatDateTime, capitalize, getDialStatusBadge, exportToCSV, renderSkeleton } from '../utils/formatters.js';
import { sanitize } from '../utils/validators.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';
import { CONDITIONS, DIAL_STATUSES, RECEPTIVENESS } from '../utils/catalog.js';

const PAGE_SIZE = 25;
let currentPage = 1;

// Who logged the call vs who actually spoke to the family. They differ when a
// call is handed over: a colleague calls because they share the family's
// language, and the assigned mentor writes it up. contacted_by_name is stamped
// with the logger's own name by every insert path, so only a genuinely
// different name (someone typed it in the correction form) shows up here.
function loggedBy(c) { return c.profiles?.full_name || capitalize((c.contacted_by_name || 'N/A').toLowerCase()); }
function spokeWith(c) {
  const logger = (c.profiles?.full_name || '').trim();
  const spoke = (c.contacted_by_name || '').trim();
  if (!spoke || !logger) return '';
  return spoke.toLowerCase() === logger.toLowerCase() ? '' : capitalize(spoke.toLowerCase());
}

export async function renderCalls(container) {
  const canExport = isManagerOrAdmin();
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Call Logs</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${canExport ? 'Every conversation, in one place' : 'Every conversation you have logged'}</p>
      </div>
      <div style="display:flex;gap:9px">
        ${canExport ? `<button class="btn btn-secondary" id="export-calls-btn">${icon('download')}Export CSV</button>` : ''}
        <button class="btn btn-primary" id="add-call-btn">${icon('plus')}Log a call</button>
      </div>
    </div>
    ${canExport ? `<div class="seg" id="calls-view-toggle" style="display:inline-flex;margin-bottom:var(--s4)">
      <button type="button" class="seg-btn on" data-view="history">${icon('phone')}<span>Call history</span></button>
      <button type="button" class="seg-btn" data-view="today">${icon('clock')}<span>Assigned for today</span></button>
    </div>` : ''}
    <div id="history-view">
    <div class="table-container">
      <div class="table-toolbar">
        <div class="table-search">
          ${icon('search')}
          <input class="form-input" id="call-search" placeholder="Search patient name or code…" />
        </div>
        <div class="table-filters">
          <select class="form-select" id="filter-status" style="width:auto;min-width:140px">
            <option value="">All outcomes</option>
            <option value="connected">Connected</option>
            <option value="no_answer">No answer</option>
            <option value="busy">Busy</option>
            <option value="callback_requested">Callback</option>
            <option value="voicemail">Voicemail</option>
            <option value="wrong_number">Wrong number</option>
          </select>
          <select class="form-select" id="filter-days" style="width:auto;min-width:130px">
            <option value="">All time</option>
            <option value="1">Today</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
      </div>
      <div id="calls-table-body">${renderSkeleton(8)}</div>
      <div class="table-pagination" id="calls-pagination"></div>
    </div>
    </div>
    <div id="today-view" style="display:none"></div>
  `;

  container.querySelectorAll('#calls-view-toggle .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    container.querySelectorAll('#calls-view-toggle .seg-btn').forEach(b => b.classList.toggle('on', b === btn));
    const today = btn.dataset.view === 'today';
    const hv = document.getElementById('history-view'); const tv = document.getElementById('today-view');
    if (hv) hv.style.display = today ? 'none' : '';
    if (tv) tv.style.display = today ? '' : 'none';
    if (today) loadTodayAssignments();
  }));

  let searchTimeout;
  container.querySelector('#call-search')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { currentPage = 1; loadCalls(); }, 300);
  });
  container.querySelector('#filter-status')?.addEventListener('change', () => { currentPage = 1; loadCalls(); });
  container.querySelector('#filter-days')?.addEventListener('change', () => { currentPage = 1; loadCalls(); });
  container.querySelector('#add-call-btn')?.addEventListener('click', () => openCallForm({ onSaved: loadCalls }));

  container.querySelector('#export-calls-btn')?.addEventListener('click', async () => {
    const sb = getSupabase();
    showToast('Preparing CSV export…', 'info');
    try {
      const { data, error } = await sb.from('call_logs')
        .select('*, patients(patient_code, full_name), profiles:caller_id(full_name)')
        .order('call_date', { ascending: false }).limit(5000);
      if (error) throw error;
      exportToCSV(data, 'call_logs_export', [
        { label: 'Date', key: 'call_date' },
        { label: 'Patient ID', accessor: r => r.patients?.patient_code || '' },
        { label: 'Patient', accessor: r => r.patients?.full_name || '' },
        { label: 'Called by', accessor: r => r.profiles?.full_name || r.contacted_by_name || '' },
        { label: 'Spoke with family', accessor: r => spokeWith(r) },
        { label: 'Outcome', key: 'dial_status' },
        { label: 'Duration (min)', key: 'call_duration_mins' },
        { label: 'Receptiveness', key: 'receptiveness_bucket' },
        { label: 'Condition', key: 'patient_condition' },
        { label: 'Asked for', key: 'requirements_noted' },
        { label: 'WhatsApp link sent', accessor: r => r.whatsapp_link_sent ? 'Yes' : 'No' },
        { label: 'WhatsApp joined', accessor: r => r.whatsapp_group_joined ? 'Yes' : 'No' },
        { label: 'Patient feedback', key: 'feedback_patient' },
        { label: 'Caregiver feedback', key: 'feedback_caregiver' },
        { label: 'Notes', key: 'caller_notes' },
        { label: 'Next follow-up', key: 'follow_up_date' },
      ]);
      showToast(`Exported ${data.length} calls`, 'success');
    } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
  });

  await loadCalls();
}

// Who is on today's calling list, and with which caregiver mentor: the
// live worklist (open queue rows), not the call history. Managers/admins only.
async function loadTodayAssignments() {
  const sb = getSupabase();
  const el = document.getElementById('today-view');
  if (!el) return;
  el.innerHTML = `<div class="table-container"><div style="padding:var(--s5)">${renderSkeleton(6)}</div></div>`;
  try {
    const { data, error } = await sb.rpc('get_queue_board');
    if (error) throw error;
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueToday = (r) => !r.scheduled_for || r.scheduled_for.slice(0, 10) <= todayStr;
    const rows = (data || []).filter(r => ['pending', 'in_progress', 'callback'].includes(r.status) && dueToday(r));
    if (!rows.length) {
      el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('clock')}</div><h4>No one is due for a call today</h4><p>Everyone's caught up, or today's list hasn't been built yet.</p></div>`;
      return;
    }
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const overdue = (r) => { if (!r.generated_for) return 0; const g = new Date(r.generated_for); g.setHours(0, 0, 0, 0); return Math.max(0, Math.round((midnight - g) / 86400000)); };
    rows.sort((a, b) => (a.assigned_name || '~').localeCompare(b.assigned_name || '~') || (a.full_name || '').localeCompare(b.full_name || ''));
    const mentors = new Set(rows.map(r => r.assigned_name).filter(Boolean));
    el.innerHTML = `
      <div class="table-container">
        <div style="padding:12px 16px;border-bottom:1px solid var(--line);font:var(--t-sm);color:var(--ink-2)">
          <strong>${rows.length}</strong> ${rows.length === 1 ? 'person' : 'people'} assigned for today's calling across <strong>${mentors.size}</strong> caregiver mentor${mentors.size === 1 ? '' : 's'}.
        </div>
        <table class="data-table">
          <thead><tr><th>Assigned to</th><th>Patient</th><th>Phone</th><th>Status</th></tr></thead>
          <tbody>
            ${rows.map(r => { const d = overdue(r);
              return `<tr class="row-link" data-pid="${r.patient_id}" tabindex="0">
                <td>${r.assigned_name ? sanitize(r.assigned_name) : '<span style="color:var(--ink-4)">Unassigned</span>'}</td>
                <td><strong>${sanitize(r.full_name || 'N/A')}</strong>${r.patient_code ? `<br><span style="font-size:12px;color:var(--ink-3)">${sanitize(r.patient_code)}</span>` : ''}</td>
                <td class="cell-mono">${sanitize(r.phone_full || 'N/A')}</td>
                <td><span class="badge badge-${r.status === 'in_progress' ? 'info' : r.status === 'callback' ? 'gold' : 'neutral'}">${capitalize((r.status || '').replace('_', ' '))}</span>${d ? ` <span class="badge badge-${d >= 7 ? 'danger' : 'warn'}">${d}d overdue</span>` : ''}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>`;
    el.querySelectorAll('tr[data-pid]').forEach(tr => tr.addEventListener('click', () => navigate('patients/' + tr.dataset.pid)));
  } catch (e) {
    el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't load assignments</h4><p>${sanitize(e.message)}</p></div>`;
  }
}

async function loadCalls() {
  const sb = getSupabase();
  const search = document.getElementById('call-search')?.value.trim() || '';
  const statusFilter = document.getElementById('filter-status')?.value || '';
  const daysFilter = document.getElementById('filter-days')?.value || '';
  const tableBody = document.getElementById('calls-table-body');
  if (!tableBody) return;

  try {
    // Left-embed patients by default so a caller's own calls survive a
    // reassignment (an inner join silently dropped every call whose patient
    // RLS no longer returned. That's why logs looked "empty"). Only force
    // an inner join when we actually filter on patient fields (search).
    const patientEmbed = search
      ? 'patients!inner(id, patient_code, full_name, assigned_to)'
      : 'patients(id, patient_code, full_name, assigned_to)';
    let query = sb.from('call_logs')
      .select(`*, ${patientEmbed}, profiles:caller_id(full_name)`, { count: 'exact' })
      .order('call_date', { ascending: false })
      .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1);

    // Your calls, full stop. Not a default the user can widen - the whole
    // point of the change is that there is nothing here to widen. Managers
    // and admins still see their team, which is what the page is for them.
    if (!isManagerOrAdmin()) {
      const me = getCurrentProfile();
      if (me?.id) query = query.eq('caller_id', me.id);
    }
    if (statusFilter) query = query.eq('dial_status', statusFilter);
    if (daysFilter) {
      const since = new Date(); since.setDate(since.getDate() - Number(daysFilter));
      query = query.gte('call_date', since.toISOString());
    }
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,patient_code.ilike.%${search}%`, { referencedTable: 'patients' });
    }

    const { data, count, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      tableBody.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('phone')}</div><h4>No calls found</h4><p>Log your first call to get started.</p></div>`;
      document.getElementById('calls-pagination').innerHTML = '';
      return;
    }

    tableBody.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Date</th><th>Patient</th><th>Called by</th><th>Outcome</th>
          <th>Condition</th><th>Asked for</th><th>Duration</th><th>Next check-in</th>
        </tr></thead>
        <tbody>
          ${data.map(c => {
            const cond = CONDITIONS.find(x => x.key === c.patient_condition);
            const caller = loggedBy(c);
            const spoke = spokeWith(c);
            return `
            <tr class="row-link" data-call='${c.id}' data-patient="${c.patients?.id || ''}" tabindex="0">
              <td>${formatDate(c.call_date)}</td>
              <td><strong style="color:var(--primary)">${c.patients?.patient_code || 'N/A'}</strong><br><span style="font-weight:600">${sanitize(c.patients?.full_name || '')}</span></td>
              <td>${sanitize(caller)}${spoke ? `<br><span style="font-size:12px;color:var(--ink-3)">spoke: ${sanitize(spoke)}</span>` : ''}</td>
              <td>${getDialStatusBadge(c.dial_status)}</td>
              <td>${cond ? `<span class="badge badge-${cond.tone === 'ok' ? 'ok' : cond.tone === 'danger' ? 'danger' : cond.tone === 'warn' ? 'warn' : 'neutral'}">${cond.label}</span>` : '<span style="color:var(--ink-4)">N/A</span>'}</td>
              <td class="cell-clamp">${c.requirements_noted ? sanitize(c.requirements_noted) : '<span style="color:var(--ink-4)">N/A</span>'}</td>
              <td>${c.call_duration_mins ? c.call_duration_mins + ' min' : 'N/A'}</td>
              <td>${c.follow_up_date ? new Date(c.follow_up_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '<span style="color:var(--ink-4)">N/A</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    const byId = Object.fromEntries(data.map(c => [c.id, c]));
    tableBody.querySelectorAll('tr[data-call]').forEach(row => {
      const open = () => showCallDetail(byId[row.dataset.call]);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });

    const totalPages = Math.ceil((count || 0) / PAGE_SIZE);
    const pagination = document.getElementById('calls-pagination');
    if (pagination) {
      pagination.innerHTML = `
        <span>Showing ${(currentPage - 1) * PAGE_SIZE + 1}-${Math.min(currentPage * PAGE_SIZE, count)} of ${count}</span>
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

function showCallDetail(c) {
  if (!c) return;
  const cond = CONDITIONS.find(x => x.key === c.patient_condition);
  const reqs = c.structured?.requirements || [];
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="kv" style="margin-bottom:var(--s4)">
      <div><div class="k">Patient</div><div class="v">${sanitize(c.patients?.full_name || 'N/A')}</div></div>
      <div><div class="k">Logged by</div><div class="v">${sanitize(loggedBy(c))}</div></div>
      ${spokeWith(c) ? `<div><div class="k">Spoke with the family</div><div class="v">${sanitize(spokeWith(c))}</div></div>` : ''}
      <div><div class="k">When</div><div class="v">${formatDateTime(c.call_date)}</div></div>
      <div><div class="k">Outcome</div><div class="v">${getDialStatusBadge(c.dial_status)}</div></div>
      <div><div class="k">Duration</div><div class="v">${c.call_duration_mins || 0} min</div></div>
      <div><div class="k">Receptiveness</div><div class="v">${c.receptiveness_bucket ? capitalize(c.receptiveness_bucket) : 'N/A'}</div></div>
      <div><div class="k">Condition</div><div class="v">${cond ? cond.label : 'N/A'}</div></div>
      <div><div class="k">Next check-in</div><div class="v">${c.follow_up_date ? formatDate(c.follow_up_date) : 'N/A'}</div></div>
      <div><div class="k">WhatsApp link sent</div><div class="v">${c.whatsapp_link_sent ? 'Yes' : 'No'}</div></div>
      <div><div class="k">Joined group</div><div class="v">${c.whatsapp_group_joined ? 'Yes' : 'No'}</div></div>
    </div>
    ${reqs.length ? `<div style="margin-bottom:var(--s4)"><div class="lever-group-title" style="margin-bottom:6px">They asked for</div>
      <div class="chip-row">${reqs.map(r => `<span class="badge badge-gold">${sanitize(r)}</span>`).join('')}</div></div>` : ''}
    ${c.caller_notes ? `<div style="margin-bottom:var(--s3)"><div class="lever-group-title" style="margin-bottom:6px">Notes</div><p style="font:var(--t-sm);color:var(--ink-2);margin:0">${sanitize(c.caller_notes)}</p></div>` : ''}
    ${c.feedback_patient ? `<p style="font:var(--t-sm);font-style:italic;color:var(--ink-2);margin:0 0 6px">“${sanitize(c.feedback_patient)}” · patient</p>` : ''}
    ${c.feedback_caregiver ? `<p style="font:var(--t-sm);font-style:italic;color:var(--ink-2);margin:0 0 6px">“${sanitize(c.feedback_caregiver)}” · caregiver</p>` : ''}
    ${c.followup_strategy_notes ? `<div class="strategy" style="margin-top:var(--s3)"><div class="strategy-title" style="margin-bottom:4px">Note for the next caller</div><div class="strategy-body">${sanitize(c.followup_strategy_notes)}</div></div>` : ''}
    <div class="form-actions">
      ${canCorrectCall(c) ? `<button class="btn btn-ghost" id="cd-edit" style="margin-right:auto">${icon('edit')}Edit call</button>` : ''}
      <button class="btn btn-secondary" id="cd-close">Close</button>
      ${c.patients?.id ? `<button class="btn btn-primary" id="cd-open-patient">${icon('user')}Open patient</button>` : ''}
    </div>
  `;
  showModal({ title: `Call · ${sanitize(c.patients?.full_name || '')}`, content: el, size: 'lg' });
  el.querySelector('#cd-close').addEventListener('click', () => closeModal());
  el.querySelector('#cd-edit')?.addEventListener('click', () => openEditCall(c));
  el.querySelector('#cd-open-patient')?.addEventListener('click', () => { closeModal(); navigate('patients/' + c.patients.id); });
}

// ---- Who may correct a logged call ----
// Managers/admins, the person who made it, and the mentor who holds the
// patient. That last one is the language-barrier case: a colleague makes the
// call, the assigned mentor writes up what was said. The server decides for
// real (correct_call_log in sql/68); this only avoids offering a button that
// would be refused.
function canCorrectCall(c) {
  if (!c) return false;
  if (isManagerOrAdmin()) return true;
  const me = getCurrentProfile();
  if (!me?.id) return false;
  return c.caller_id === me.id || c.patients?.assigned_to === me.id;
}

// ---- Correct a logged call ----
// Two things used to go wrong here. The form only covered duration, outcome
// and the next check-in, so "the conversation details" could not be corrected
// at all. And the save was a plain UPDATE: when RLS filtered the row out
// (someone else's call), PostgREST returned 204 with no error, so the modal
// closed and said "Call corrected" over a write that never happened. It now
// goes through correct_call_log(), which refuses out loud and returns the
// saved row, so nothing is reported as saved unless the row came back.
// The audit trigger still fires on UPDATE, so corrections stay traceable.
function openEditCall(c) {
  if (!c) return;
  const el = document.createElement('div');
  const curFollow = c.follow_up_date ? String(c.follow_up_date).slice(0, 10) : '';
  const durVal = (c.call_duration_mins != null && c.call_duration_mins !== '') ? c.call_duration_mins : '';
  const spokeTo = c.profiles?.full_name || c.contacted_by_name || '';
  const askedFor = c.requirements_noted || (c.structured?.requirements || []).join(', ');
  const val = (v) => sanitize(v == null ? '' : String(v));
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      Correcting <strong>${sanitize(c.patients?.full_name || 'this call')}</strong> ·
      logged ${formatDateTime(c.call_date)} by ${sanitize(loggedBy(c))}.
      Leave anything you don't know exactly as it is.
    </p>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Call duration (minutes) <span class="req">*</span></label>
        <input class="input" id="ec-duration" type="number" min="0" max="600" step="1" value="${durVal}" />
        <div class="due-meta" style="margin-top:5px">${durVal === '' ? 'No length was recorded. Enter the real one.' : `Was recorded as <strong>${durVal} min</strong>. Enter the real length.`}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Outcome</label>
        <select class="select" id="ec-status">
          ${DIAL_STATUSES.map(o => `<option value="${o.key}" ${c.dial_status === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">How were they doing?</label>
        <select class="select" id="ec-recep">
          <option value="">N/A</option>
          ${RECEPTIVENESS.map(r => `<option value="${r.key}" ${c.receptiveness_bucket === r.key ? 'selected' : ''}>${r.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">How is the patient doing?</label>
        <select class="select" id="ec-condition">
          <option value="">N/A</option>
          ${CONDITIONS.map(o => `<option value="${o.key}" ${c.patient_condition === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Who actually spoke to the family?</label>
      <input class="input" id="ec-spoke" value="${val(spokeTo)}" placeholder="e.g. the colleague who called for you" />
      <div class="due-meta" style="margin-top:5px">Use this when someone else made the call, for language or for cover.</div>
    </div>
    <div class="form-group">
      <label class="form-label">What did they ask for?</label>
      <input class="input" id="ec-asked" value="${val(askedFor)}" placeholder="Separate things with commas" />
    </div>
    <div class="form-group">
      <label class="form-label">Notes from the conversation</label>
      <textarea class="textarea" id="ec-notes" rows="4" placeholder="What was actually said…">${val(c.caller_notes)}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Feedback from the patient</label>
        <input class="input" id="ec-fb-patient" value="${val(c.feedback_patient)}" placeholder="In their words…" />
      </div>
      <div class="form-group">
        <label class="form-label">Feedback from the caregiver</label>
        <input class="input" id="ec-fb-caregiver" value="${val(c.feedback_caregiver)}" placeholder="In their words…" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">A note to hand the next caregiver mentor</label>
      <textarea class="textarea" id="ec-strategy" rows="3" placeholder="What helped, what to lead with, the best time to reach them…">${val(c.followup_strategy_notes)}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Next check-in</label>
      <input class="input" id="ec-followup" type="date" value="${curFollow}" />
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="ec-cancel">Cancel</button>
      <button class="btn btn-primary" id="ec-save">${icon('check')}Save correction</button>
    </div>`;
  showModal({ title: 'Edit call', content: el, size: 'lg' });
  el.querySelector('#ec-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#ec-save').addEventListener('click', async () => {
    const txt = (id) => el.querySelector('#' + id).value.trim();
    const raw = txt('ec-duration');
    if (raw === '') { showToast('Enter the call duration in minutes', 'warning'); return; }
    const dur = Number(raw);
    if (!Number.isFinite(dur) || dur < 0 || dur > 600) { showToast('Duration must be between 0 and 600 minutes', 'warning'); return; }

    // Send only what actually changed, so an untouched field is never rewritten.
    const patch = {};
    const put = (col, next, was) => { if (next !== (was == null || was === '' ? null : was)) patch[col] = next; };
    put('call_duration_mins', dur, c.call_duration_mins == null ? null : Number(c.call_duration_mins));
    put('dial_status', txt('ec-status') || null, c.dial_status);
    put('receptiveness_bucket', txt('ec-recep') || null, c.receptiveness_bucket);
    put('patient_condition', txt('ec-condition') || null, c.patient_condition);
    put('contacted_by_name', txt('ec-spoke') || null, c.profiles?.full_name || c.contacted_by_name);
    put('caller_notes', txt('ec-notes') || null, c.caller_notes);
    put('feedback_patient', txt('ec-fb-patient') || null, c.feedback_patient);
    put('feedback_caregiver', txt('ec-fb-caregiver') || null, c.feedback_caregiver);
    put('followup_strategy_notes', txt('ec-strategy') || null, c.followup_strategy_notes);
    put('follow_up_date', txt('ec-followup') || null, curFollow || null);

    // "What they asked for" lives in two places: the text column the table and
    // the CSV export read, and the chip list in `structured`. Write both, or a
    // stale set of chips next to corrected text reads as another failed save.
    const askedNow = txt('ec-asked');
    if (askedNow !== (askedFor || '')) {
      patch.requirements_noted = askedNow || null;
      patch.structured = { ...(c.structured || {}), custom_requirement: null,
        requirements: askedNow.split(',').map(s => s.trim()).filter(Boolean) };
    }

    if (!Object.keys(patch).length) { showToast('Nothing was changed', 'info'); return; }

    const btn = el.querySelector('#ec-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Saving…';
    try {
      const { data: saved, error } = await getSupabase().rpc('correct_call_log', { p_call_id: c.id, p_fields: patch });
      if (error) throw error;
      if (!saved) throw new Error('the server did not confirm the change, so nothing was saved');
      Object.assign(c, saved);
      closeModal();
      showToast('Call corrected', 'success');
      loadCalls();
    } catch (e) {
      showToast('Could not save: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}Save correction`;
    }
  });
}
