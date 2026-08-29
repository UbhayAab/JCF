// ============================================================
// Patient Navigator: Intake report
// Every patient an uploader has onboarded, since the day they
// joined: counts, hospital split, full table, CSV download.
// Uploaders see themselves; managers/admins pick any uploader.
// Born from Ayushi's ask: "Dr Lahari needs the total number of
// patients I onboarded from TMH."
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { capitalize, exportToCSV } from '../utils/formatters.js';

const READER_ROLES = ['admin', 'manager', 'content'];

let rows = [];          // full report for the selected uploader
let uploaderName = '';  // for the CSV filename + headline

export async function renderIntake(container) {
  const role = getUserRole();
  const me = getCurrentProfile();
  const isReader = READER_ROLES.includes(role);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Intake report</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Everyone ${isReader ? 'an uploader has' : 'you have'} onboarded: full history, latest status, one-click download.</p>
      </div>
      <div class="flex gap-2" style="align-items:center;flex-wrap:wrap">
        ${isReader ? `<select class="form-select" id="ir-uploader" style="width:auto;min-width:220px"><option>Loading…</option></select>` : ''}
        <button class="btn btn-primary" id="ir-download" disabled>${icon('download')}Download CSV</button>
      </div>
    </div>

    <div class="stats-grid" id="ir-tiles" style="margin-bottom:var(--s4)">
      ${Array(4).fill('<div class="card stat-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-text"></div></div>').join('')}
    </div>

    <div class="card" style="margin-bottom:var(--s4);display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <input class="input" id="ir-search" placeholder="Search name, code, phone, city…" style="flex:1;min-width:220px" />
      <select class="select" id="ir-hospital" style="width:auto;min-width:200px"><option value="">All hospitals</option></select>
      <select class="select" id="ir-status" style="width:auto;min-width:150px"><option value="">All statuses</option></select>
    </div>

    <div id="ir-table">${Array(5).fill('<div class="skeleton skeleton-row" style="height:48px;margin-bottom:8px"></div>').join('')}</div>
  `;

  const sb = getSupabase();
  const $ = (s) => container.querySelector(s);

  async function loadReport(uploaderId, name) {
    uploaderName = name || me?.full_name || 'uploader';
    const tableEl = $('#ir-table');
    tableEl.innerHTML = Array(5).fill('<div class="skeleton skeleton-row" style="height:48px;margin-bottom:8px"></div>').join('');
    try {
      const { data, error } = await sb.rpc('get_intake_report', uploaderId ? { p_uploader: uploaderId } : {});
      if (error) throw error;
      rows = data || [];
      renderTiles(container);
      buildFilters(container);
      renderTable(container);
      $('#ir-download').disabled = rows.length === 0;
    } catch (e) {
      tableEl.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't load the report</h4><p>${e.message}</p></div>`;
    }
  }

  if (isReader) {
    try {
      const { data, error } = await sb.rpc('get_intake_uploaders');
      if (error) throw error;
      const ups = data || [];
      const sel = $('#ir-uploader');
      sel.innerHTML = ups.map(u =>
        `<option value="${u.uploader_id}">${sanitize(u.full_name)} · ${u.patients_added} added${u.is_active ? '' : ' (inactive)'}</option>`).join('')
        || '<option value="">No uploads yet</option>';
      sel.addEventListener('change', () => {
        const u = ups.find(x => x.uploader_id === sel.value);
        loadReport(sel.value, u?.full_name);
      });
      // default: the biggest intake contributor who is NOT an admin, else first
      const first = ups.find(u => u.role !== 'admin') || ups[0];
      if (first) { sel.value = first.uploader_id; await loadReport(first.uploader_id, first.full_name); }
    } catch (e) { showToast('Could not load uploaders: ' + e.message, 'error'); }
  } else {
    await loadReport(null, me?.full_name);
  }

  $('#ir-search').addEventListener('input', () => renderTable(container));
  $('#ir-hospital').addEventListener('change', () => renderTable(container));
  $('#ir-status').addEventListener('change', () => renderTable(container));
  $('#ir-download').addEventListener('click', () => downloadCSV());
}

function renderTiles(container) {
  const total = rows.length;
  const byHospital = {};
  rows.forEach(r => { const h = normHospital(r.treating_hospital); if (h) byHospital[h] = (byHospital[h] || 0) + 1; });
  const top = Object.entries(byHospital).sort((a, b) => b[1] - a[1])[0];
  const reached = rows.filter(r => Number(r.connected_calls) > 0).length;
  const waiting = rows.filter(r => r.patient_status === 'new_lead').length;
  const el = container.querySelector('#ir-tiles');
  if (!el) return;
  const tile = (big, label, sub, ico, cls = '') => `
    <div class="card stat-card"><div class="flex justify-between items-center">
      <div><div class="stat-value">${big}</div><div class="stat-label">${label}</div>
      ${sub ? `<div class="faint" style="font-size:11.5px;color:var(--ink-3);margin-top:2px">${sub}</div>` : ''}</div>
      <div class="stat-icon ${cls}">${icon(ico)}</div></div></div>`;
  el.innerHTML =
    tile(total, `Onboarded by ${sanitize(uploaderName)}`, 'since they joined', 'users') +
    tile(top ? top[1] : 0, top ? `From ${sanitize(top[0])}` : 'From hospitals', top ? 'the number for the doctors' : '', 'mapPin') +
    tile(reached, 'Reached', 'at least one connected call', 'phoneCall') +
    tile(waiting, 'Waiting', 'new leads not yet called', 'inbox');
}

// Hospital names arrive in many spellings. Group them loosely for the
// filter and tiles ("Tata Memorial hospital" = "Tata Memorial Hospital").
function normHospital(h) {
  const s = String(h || '').trim();
  if (!s) return '';
  if (/tata|tmh/i.test(s)) return 'Tata Memorial Hospital';
  return s.replace(/\s+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function buildFilters(container) {
  const hsel = container.querySelector('#ir-hospital');
  const ssel = container.querySelector('#ir-status');
  if (!hsel || !ssel) return;
  const hs = {}; const st = {};
  rows.forEach(r => {
    const h = normHospital(r.treating_hospital) || '(no hospital)';
    hs[h] = (hs[h] || 0) + 1;
    st[r.patient_status] = (st[r.patient_status] || 0) + 1;
  });
  hsel.innerHTML = '<option value="">All hospitals</option>' +
    Object.entries(hs).sort((a, b) => b[1] - a[1]).map(([h, n]) => `<option value="${sanitize(h)}">${sanitize(h)} (${n})</option>`).join('');
  ssel.innerHTML = '<option value="">All statuses</option>' +
    Object.entries(st).sort((a, b) => b[1] - a[1]).map(([s, n]) => `<option value="${s}">${capitalize(String(s).replace('_', ' '))} (${n})</option>`).join('');
}

function filteredRows(container) {
  const q = (container.querySelector('#ir-search')?.value || '').toLowerCase().trim();
  const h = container.querySelector('#ir-hospital')?.value || '';
  const s = container.querySelector('#ir-status')?.value || '';
  return rows.filter(r => {
    if (h && (normHospital(r.treating_hospital) || '(no hospital)') !== h) return false;
    if (s && r.patient_status !== s) return false;
    if (!q) return true;
    return [r.full_name, r.patient_code, r.phones, r.city, r.state, r.cancer_type, r.assigned_mentor]
      .some(v => String(v || '').toLowerCase().includes(q));
  });
}

function renderTable(container) {
  const el = container.querySelector('#ir-table');
  if (!el) return;
  const list = filteredRows(container);
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('inbox')}</div><h4>Nothing here</h4><p>${rows.length ? 'No rows match the current filters.' : 'No patients onboarded yet. They appear the moment an upload lands.'}</p></div>`;
    return;
  }
  const d = (v) => v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : 'N/A';
  el.innerHTML = `
    <div class="table-container"><table class="data-table" style="font-size:12.5px">
      <thead><tr>
        <th>Code</th><th>Name</th><th>Phones</th><th>Hospital</th><th>City</th>
        <th>Cancer</th><th>Status</th><th>Uploaded</th><th>Mentor</th><th>Calls</th><th>Last call</th>
      </tr></thead>
      <tbody>${list.map(r => `
        <tr style="cursor:pointer" data-pid="${r.patient_id}">
          <td class="tnum">${r.patient_code || ''}</td>
          <td style="font-weight:600">${sanitize(r.full_name || '')}</td>
          <td class="tnum" style="white-space:normal;min-width:150px">${sanitize(r.phones || '')}</td>
          <td>${sanitize(normHospital(r.treating_hospital) || 'N/A')}</td>
          <td>${sanitize(r.city || 'N/A')}</td>
          <td>${sanitize(r.cancer_type || 'N/A')}</td>
          <td><span class="badge badge-${r.patient_status === 'active' ? 'ok' : r.patient_status === 'new_lead' ? 'info' : 'neutral'}">${capitalize(String(r.patient_status || '').replace('_', ' '))}</span></td>
          <td class="tnum">${d(r.uploaded_at)}</td>
          <td>${sanitize(r.assigned_mentor || 'N/A')}</td>
          <td class="tnum">${r.total_calls}${Number(r.connected_calls) ? ` <span class="faint" style="color:var(--ink-3)">(${r.connected_calls}✓)</span>` : ''}</td>
          <td class="tnum">${d(r.last_call_at)}</td>
        </tr>`).join('')}</tbody>
    </table>
    <div style="font-size:12px;color:var(--ink-3);padding:8px 2px">${list.length} of ${rows.length} shown · ✓ = connected calls</div></div>`;
  el.querySelectorAll('tr[data-pid]').forEach(tr =>
    tr.addEventListener('click', () => { window.location.hash = 'patients/' + tr.dataset.pid; }));
}

// Uses the shared writer rather than a second hand-rolled one, so the phone
// column gets the same Excel text treatment as every other export.
function downloadCSV() {
  if (!rows.length) return;
  const day = (x) => (x ? new Date(x).toLocaleDateString('en-IN') : '');
  const v = (x) => (x === null || x === undefined ? '' : x);
  exportToCSV(rows, `intake_${uploaderName.replace(/\s+/g, '_').toLowerCase()}`, [
    { label: 'Patient code',     key: 'patient_code' },
    { label: 'Name',             key: 'full_name' },
    { label: 'Phone numbers',    key: 'phones', text: true },
    { label: 'Hospital',         key: 'treating_hospital' },
    { label: 'City',             key: 'city' },
    { label: 'State',            key: 'state' },
    { label: 'Cancer type',      key: 'cancer_type' },
    { label: 'GI subtype',       key: 'gi_subtype' },
    { label: 'Age',              key: 'age' },
    { label: 'Gender',           key: 'gender' },
    { label: 'Status',           key: 'patient_status' },
    { label: 'Consent',          accessor: (r) => v(r.consent_given) },
    { label: 'Uploaded on',      accessor: (r) => day(r.uploaded_at) },
    { label: 'Assigned mentor',  key: 'assigned_mentor' },
    { label: 'Total calls',      accessor: (r) => v(r.total_calls) },
    { label: 'Connected calls',  accessor: (r) => v(r.connected_calls) },
    { label: 'Last call',        accessor: (r) => day(r.last_call_at) },
    { label: 'Caregiver',        key: 'caregiver_name' },
    { label: 'Intake notes',     key: 'legacy_notes' },
  ]);
  showToast(`${rows.length} rows downloaded`, 'success');
}
