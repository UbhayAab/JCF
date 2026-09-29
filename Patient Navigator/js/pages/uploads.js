// ============================================================
// Patient Navigator: Document uploads (who uploaded what, for whom)
//
// Asked for on 28 Sep 2026 by Aadrika: "View access for me to see which
// intern uploaded documents of which patients." Every upload has always been
// stamped with uploaded_by and uploaded_at on document_batches; nothing showed
// it except one patient's own Documents tab, one family at a time. On 29 Sep
// alone 19 uploads came from 8 people.
//
// get_document_upload_log() (sql/146) does the access decision: managers and
// admins get every upload, anyone else only their own, whatever they ask for.
// So this page is safe to open to every role; for a mentor it is simply
// "your uploads".
// ============================================================

import { getSupabase } from '../supabase.js';
import { isManagerOrAdmin } from '../auth.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { exportToCSV, roleLabel } from '../utils/formatters.js';
import { navigate } from '../router.js';
import { openDocumentViewer, fmtDayTime, daysAgo } from '../components/docViewer.js';
import { docClassLabel, uploadStatusLabel } from '../utils/docClasses.js';

let rows = [];
let range = '7';        // '1' today | '7' | '30' | 'all'
let uploader = '';      // profile id, or '' for everyone
let searchQ = '';

const IST_DAY = (d) => new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
function fromDate(r) {
  if (r === 'all') return null;
  const d = IST_DAY(new Date());
  d.setDate(d.getDate() - (Number(r) - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const tone = (s) => (s === 'reviewed' ? 'ok' : s === 'ready_for_review' ? 'warn' : s === 'failed' ? 'danger' : 'neutral');

export async function renderUploads(container) {
  const all = isManagerOrAdmin();
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${all ? 'Document uploads' : 'Your uploads'}</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${all
          ? 'Who uploaded which family\'s documents, when, and whether anyone has reviewed them. Open any upload to see its pages.'
          : 'Every document you have uploaded, with whether it has been read and reviewed.'}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="up-refresh">${icon('refresh')}Refresh</button>
        <button class="btn btn-secondary btn-sm" id="up-csv">${icon('download')}Download CSV</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s4)">
      <div class="chip-row" id="up-range">
        <button type="button" class="fchip" data-r="1">Today</button>
        <button type="button" class="fchip" data-r="7">7 days</button>
        <button type="button" class="fchip" data-r="30">30 days</button>
        <button type="button" class="fchip" data-r="all">All time</button>
      </div>
      ${all ? `<select class="select" id="up-who" style="max-width:240px" aria-label="Uploaded by"><option value="">Everyone</option></select>` : ''}
      <div class="table-search" style="max-width:360px;flex:1 1 220px">
        ${icon('search')}
        <input class="form-input" id="up-search" type="search" autocomplete="off" placeholder="Patient name or PAT code" aria-label="Search uploads" />
      </div>
    </div>
    <div id="up-people"></div>
    <div id="up-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading uploads…</div></div>`;

  const paintRange = () => container.querySelectorAll('#up-range .fchip')
    .forEach(b => b.classList.toggle('on', b.dataset.r === range));
  paintRange();
  container.querySelectorAll('#up-range .fchip').forEach(b => b.addEventListener('click', () => {
    range = b.dataset.r; paintRange(); load(container);
  }));
  container.querySelector('#up-who')?.addEventListener('change', (e) => { uploader = e.target.value; paint(container); });
  container.querySelector('#up-search')?.addEventListener('input', (e) => { searchQ = e.target.value.trim().toLowerCase(); paint(container); });
  container.querySelector('#up-refresh')?.addEventListener('click', () => load(container));
  container.querySelector('#up-csv')?.addEventListener('click', () => {
    const list = visible();
    if (!list.length) return;
    exportToCSV(list, 'document_uploads', [
      { label: 'Uploaded at (IST)', accessor: (r) => fmtDayTime(r.uploaded_at) },
      { label: 'Uploaded by', accessor: (r) => r.uploader_name || (r.uploaded_by ? 'Unknown' : 'WhatsApp') },
      { label: 'Role', accessor: (r) => (r.uploader_role ? roleLabel(r.uploader_role) : '') },
      { label: 'Patient code', key: 'patient_code' },
      { label: 'Patient', key: 'patient_name' },
      { label: 'Files picked', key: 'source_files' },
      { label: 'Pages', key: 'page_count' },
      { label: 'Documents found', key: 'documents' },
      { label: 'Document types', accessor: (r) => (r.doc_types || []).map(docClassLabel).join('; ') },
      { label: 'Status', accessor: (r) => uploadStatusLabel(r.status) },
      { label: 'Reviewed by', key: 'reviewed_by_name' },
      { label: 'Reviewed at (IST)', accessor: (r) => (r.reviewed_at ? fmtDayTime(r.reviewed_at) : '') },
    ]);
  });
  await load(container);
}

async function load(container) {
  const body = container.querySelector('#up-body');
  try {
    const { data, error } = await getSupabase().rpc('get_document_upload_log', {
      p_from: fromDate(range), p_to: null, p_limit: 2000,
    });
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    if (body) body.innerHTML = `<div class="card"><div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div>
      <h4>Could not load the uploads</h4><p>${sanitize(e.message)}</p></div></div>`;
    return;
  }
  // Uploader list from what is actually in range, busiest first.
  const who = container.querySelector('#up-who');
  if (who) {
    const people = [...rows.reduce((m, r) => {
      if (!r.uploaded_by) return m;
      const p = m.get(r.uploaded_by) || { id: r.uploaded_by, name: r.uploader_name || 'Unknown', n: 0 };
      p.n++; m.set(r.uploaded_by, p); return m;
    }, new Map()).values()].sort((a, b) => b.n - a.n);
    if (uploader && !people.some(p => p.id === uploader)) uploader = '';
    who.innerHTML = `<option value="">Everyone (${rows.length})</option>` + people.map(p =>
      `<option value="${sanitize(p.id)}" ${p.id === uploader ? 'selected' : ''}>${sanitize(p.name)} (${p.n})</option>`).join('');
  }
  paint(container);
}

function visible() {
  return rows
    .filter(r => !uploader || r.uploaded_by === uploader)
    .filter(r => !searchQ || [r.patient_name, r.patient_code].filter(Boolean).join(' ').toLowerCase().includes(searchQ));
}

function paint(container) {
  const body = container.querySelector('#up-body');
  const peopleEl = container.querySelector('#up-people');
  const list = visible();
  const label = range === '1' ? 'today' : range === 'all' ? 'in all' : `in the last ${range} days`;

  // One line per person: the question Aadrika asked, answered at a glance.
  const byPerson = [...list.reduce((m, r) => {
    const k = r.uploaded_by || 'whatsapp';
    const p = m.get(k) || { name: r.uploader_name || (r.uploaded_by ? 'Unknown' : 'Sent on WhatsApp'), role: r.uploader_role, uploads: 0, pages: 0, fams: new Set(), last: null, waiting: 0 };
    p.uploads++; p.pages += r.page_count || 0; p.fams.add(r.patient_id);
    if (!p.last || r.uploaded_at > p.last) p.last = r.uploaded_at;
    if (r.status === 'ready_for_review') p.waiting++;
    m.set(k, p); return m;
  }, new Map()).values()].sort((a, b) => b.uploads - a.uploads);

  if (peopleEl) {
    peopleEl.innerHTML = isManagerOrAdmin() && byPerson.length ? `
      <div class="card card-flush" style="margin-bottom:var(--s4)">
        <div class="card-head"><h3>By person, ${label}</h3><span class="badge badge-neutral">${byPerson.length} ${byPerson.length === 1 ? 'person' : 'people'}</span></div>
        <div class="table-container"><table class="data-table">
          <thead><tr><th>Uploaded by</th><th>Role</th><th>Uploads</th><th>Families</th><th>Pages</th><th>Waiting for review</th><th>Last upload</th></tr></thead>
          <tbody>${byPerson.map(p => `<tr>
            <td><strong>${sanitize(p.name)}</strong></td>
            <td>${p.role ? sanitize(roleLabel(p.role)) : ''}</td>
            <td class="tnum">${p.uploads}</td><td class="tnum">${p.fams.size}</td><td class="tnum">${p.pages}</td>
            <td class="tnum">${p.waiting ? `<span class="badge badge-warn">${p.waiting}</span>` : '0'}</td>
            <td>${sanitize(fmtDayTime(p.last))}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : '';
  }

  if (!list.length) {
    body.innerHTML = `<div class="card"><div class="empty"><div class="ico-wrap">${icon('fileText')}</div>
      <h4>No uploads ${label}</h4><p>${searchQ || uploader ? 'Nothing matches those filters.' : 'Try a longer range.'}</p></div></div>`;
    return;
  }
  body.innerHTML = `
    <div class="card card-flush">
      <div class="card-head"><h3>Uploads ${label}</h3><span class="badge badge-neutral">${list.length}</span></div>
      <div class="table-container"><table class="data-table">
        <thead><tr><th>When</th><th>Uploaded by</th><th>Patient</th><th>Pages</th><th>What was in it</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map(r => `<tr>
          <td style="white-space:nowrap">${sanitize(fmtDayTime(r.uploaded_at))}<div class="due-meta">${sanitize(daysAgo(r.uploaded_at))}</div></td>
          <td><strong>${sanitize(r.uploader_name || (r.uploaded_by ? 'Unknown' : 'WhatsApp'))}</strong>${r.uploader_role ? `<div class="due-meta">${sanitize(roleLabel(r.uploader_role))}</div>` : ''}</td>
          <td><a href="#patients/${sanitize(r.patient_id)}" data-open="${sanitize(r.patient_id)}">${sanitize(r.patient_name || 'Patient')}</a><div class="due-meta">${sanitize(r.patient_code || '')}</div></td>
          <td class="tnum">${r.page_count || 0}</td>
          <td>${(r.doc_types || []).length ? sanitize(r.doc_types.map(docClassLabel).join(', ')) : `<span class="due-meta">${r.documents ? r.documents + ' document(s)' : 'not sorted yet'}</span>`}</td>
          <td><span class="badge badge-${tone(r.status)}">${sanitize(uploadStatusLabel(r.status))}</span>
            ${r.reviewed_by_name ? `<div class="due-meta" style="margin-top:4px">by ${sanitize(r.reviewed_by_name)}, ${sanitize(fmtDayTime(r.reviewed_at))}</div>` : ''}</td>
          <td>${(r.page_count || 0) > 0 && r.status !== 'discarded'
            ? `<button type="button" class="btn btn-secondary btn-sm" data-view="${sanitize(r.batch_id)}" data-pid="${sanitize(r.patient_id)}" data-name="${sanitize(r.patient_name || '')}">${icon('eye')}View</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${rows.length >= 2000 ? '<div class="due-meta" style="padding:10px 16px">Showing the latest 2000. Narrow the range to see older uploads.</div>' : ''}
    </div>`;
  body.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => openDocumentViewer({
    patientId: b.dataset.pid, patientName: b.dataset.name || '', batchId: b.dataset.view,
  })));
  body.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); navigate('patients/' + a.dataset.open);
  }));
}
