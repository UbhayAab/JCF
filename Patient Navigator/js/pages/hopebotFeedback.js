import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal } from '../components/modal.js';
import { HOPEBOT_FEEDBACK_FEATURES, mountHopebotFeedback } from '../components/hopebotFeedback.js';

const mounts = new WeakMap();
const SOURCES = { observed: 'Observed HopeBot activity', self_report: 'Call feedback', imported_history: 'Imported source history' };
const STATES = { pending: 'Pending', awaiting_capacity: 'Awaiting daily capacity', held: 'Held', attempted: 'Attempted', feedback_recorded: 'Feedback recorded' };
const PAGE_SIZE = 25, EXPORT_LIMIT = 5000;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = value => typeof value === 'string' ? value : '';
const identity = () => JSON.stringify([getCurrentUser()?.id, getRealProfile()?.id, getCurrentProfile()?.id, isImpersonating()]);
function manager() {
  const profile = getRealProfile();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const day = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
  return !!getCurrentUser()?.id && profile?.id === getCurrentUser().id && ['manager', 'admin'].includes(profile.role) && profile.is_active === true && (!profile.ends_on || profile.ends_on >= day) && !isImpersonating() && getCurrentProfile()?.id === profile.id;
}
function validDay(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function label(value, fallback) { return text(value).replaceAll('_', ' ') || fallback; }
function featureText(row) {
  if (row.source === 'imported_history') return text(row.features_text) || 'Not recorded in the source';
  const features = row.features.map(code => HOPEBOT_FEEDBACK_FEATURES[code]).join('; ');
  if (row.source === 'observed') return text(row.features_text).trim() || (features ? 'Observed activity: ' + features : 'Feature not recorded');
  if (row.usage === 'no') return 'Reported no use';
  if (row.usage !== 'yes') return 'Not asked / unknown';
  return features || 'Used - features not recorded';
}
function readRow(row) {
  if (!row || !uuid(row.id) || !Object.hasOwn(SOURCES, row.source)) throw new Error('Invalid tracker row');
  for (const field of ['patient_id', 'owner_id', 'call_id']) if (row[field] != null && !uuid(row[field])) throw new Error('Invalid tracker identity');
  const features = row.features ?? [];
  if (!Array.isArray(features) || features.length > 12 || features.some(code => !Object.hasOwn(HOPEBOT_FEEDBACK_FEATURES, code))) throw new Error('Invalid tracker features');
  if (row.source === 'observed' && row.features_text != null && (typeof row.features_text !== 'string' || row.features_text.length > 500)) throw new Error('Invalid observed feature label');
  return { ...row, features: [...features] };
}
function readResult(data, offset, limit) {
  if (!data || !Array.isArray(data.rows) || data.rows.length > limit || !Number.isSafeInteger(data.total) || data.total < 0 || (data.rows.length && data.total < offset + data.rows.length) || !Array.isArray(data.owners) || data.truncated === true) throw new Error('Incomplete tracker result');
  const rows = data.rows.map(readRow);
  if (new Set(rows.map(row => row.id)).size !== rows.length || data.owners.some(owner => !uuid(owner?.id) || typeof owner.name !== 'string')) throw new Error('Invalid tracker identities');
  return { rows, total: data.total, owners: [...new Map(data.owners.map(owner => [owner.id, { id: owner.id, name: owner.name }])).values()] };
}
export function hopebotFeedbackCsvCell(value) {
  let cell = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = "'" + cell;
  return '"' + cell.replaceAll('"', '""') + '"';
}
function csvFields(row) {
  return [row.patient_code || row.patient_id || (row.source_patient_id ? 'Unverified source: ' + row.source_patient_id : 'Unlinked - no verified Patient ID'), row.patient_name || 'Name not recorded', featureText(row), row.feedback || '', row.date_text || 'Date not recorded', row.owner_name || 'Not recorded', SOURCES[row.source], row.current_owner_name || 'Not verified', label(row.call_status, 'No saved call status'), STATES[row.work_status] || label(row.work_status, 'Work state not recorded'), label(row.identity_status, 'Not reviewed'), row.due_day || 'Not recorded', row.usage === 'yes' ? 'Yes' : row.usage === 'no' ? 'No' : 'Not asked / unknown', row.other || '', row.call_kind || '', row.call_id || '', row.version ?? '', row.updated_at || ''];
}
const fingerprint = row => JSON.stringify([row.id, ...csvFields(row)]);

export async function renderHopebotFeedback(container) {
  if (!container) return { refresh() {}, dispose() {} };
  mounts.get(container)?.dispose();
  const account = identity(), route = window.location.hash;
  let disposed = false, generation = 0, filterRevision = 0, exportGeneration = 0;
  let loading = false, exporting = false, offset = 0, result = { rows: [], total: 0, owners: [] };
  let applied = { p_from: null, p_to: null, p_owner: null, p_source: null, p_status: null };
  let observer, subscription, dialog, root;
  const current = () => !disposed && mounts.get(container) === controller && container.isConnected && root?.isConnected && container.contains(root) && route === window.location.hash && account === identity() && manager();
  function closeDialog() { dialog?.feedback?.dispose(); dialog?.modal?.closeOwnedModal(); dialog = null; }
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; exportGeneration++; observer?.disconnect(); subscription?.unsubscribe(); closeDialog();
    window.removeEventListener('hashchange', checkIdentity);
    if (mounts.get(container) === controller) { if (root && container.contains(root)) root.remove(); mounts.delete(container); }
  }
  function checkIdentity() { if (!current()) dispose(); }
  function active(seq = generation) { if (seq !== generation || disposed) return false; if (!current()) { dispose(); return false; } return true; }
  function message(value, error = false) {
    const host = container.querySelector('[data-hbt-message]');
    if (host) { host.textContent = value; host.style.color = error ? 'var(--danger, #b42318)' : ''; }
  }
  const controller = { refresh: () => load(), dispose }; mounts.set(container, controller);
  if (!manager()) {
    container.innerHTML = '<section class="card" style="padding:20px"><h1>HopeBot feedback</h1><p role="status">' + (isImpersonating() ? 'Exit Open as to view the tracker for your signed-in manager account.' : 'This tracker is available to active managers and admins only.') + '</p></section>';
    root = container.firstElementChild;
    return controller;
  }
  container.innerHTML = `<div class="hbf-tracker" style="min-width:0;overflow-wrap:anywhere">
    <style>.hbf-tracker .hbf-filter-grid,.hbf-tracker .hbf-row-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.hbf-tracker .hbf-filter-grid>*{min-width:0}.hbf-tracker .hbf-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.hbf-tracker .hbf-row-fields dt{font-size:12px;font-weight:700;margin:0 0 4px}.hbf-tracker .hbf-row-fields dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.hbf-tracker .hbf-row-fields>div{min-width:0}.hbf-tracker .hbf-row{padding:18px;margin:12px 0}.hbf-tracker .hbf-filter-grid input,.hbf-tracker .hbf-filter-grid select{width:100%;max-width:100%;box-sizing:border-box}.hbf-tracker .hbf-row-header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}.hbf-tracker .due-meta{white-space:normal;overflow-wrap:anywhere}.hbf-tracker [hidden]{display:none!important}@media(max-width:600px){.hbf-tracker .hbf-filter-grid,.hbf-tracker .hbf-row-fields{grid-template-columns:1fr}.hbf-tracker .hbf-row{padding:14px}.hbf-tracker .hbf-actions .btn{max-width:100%;white-space:normal}}</style>
    <div class="page-header"><div><h1>HopeBot feedback</h1><p class="header-subtitle">Source history, observed activity and saved-call feedback remain separate.</p></div></div>
    <form class="card" data-hbt-filters style="padding:18px"><div class="hbf-filter-grid">
    <label><span class="form-label">From date</span><input class="form-input" type="date" name="from"></label><label><span class="form-label">To date</span><input class="form-input" type="date" name="to"></label>
    <label><span class="form-label">Intern / owner</span><select class="form-select" name="owner"><option value="">All authorized interns</option></select></label>
    <label><span class="form-label">Source</span><select class="form-select" name="source"><option value="">All sources</option>${Object.entries(SOURCES).map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></label>
    <label><span class="form-label">Work status</span><select class="form-select" name="status"><option value="">All statuses</option>${Object.entries(STATES).map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></label>
    </div><div class="hbf-actions" style="margin-top:14px"><button class="btn btn-primary" type="submit">Apply filters</button><button class="btn btn-secondary" type="button" data-hbt-reset>Reset filters</button><button class="btn btn-secondary" type="button" data-hbt-refresh>Refresh</button><button class="btn btn-secondary" type="button" data-hbt-export>Export filtered CSV</button></div>
    <p class="due-meta">The date filter uses verified dates. Ambiguous source dates are shown as recorded. Export uses the applied filters, up to 5000 rows.</p><p data-hbt-message role="status" aria-live="polite"></p></form>
    <div data-hbt-rows></div><div class="hbf-actions" data-hbt-pagination style="margin:16px 0 28px"><button class="btn btn-secondary" type="button" data-hbt-prev>Previous</button><span data-hbt-count role="status"></span><button class="btn btn-secondary" type="button" data-hbt-next>Next</button></div></div>`;
  root = container.querySelector('.hbf-tracker');
  const form = root.querySelector('[data-hbt-filters]'), rowsHost = root.querySelector('[data-hbt-rows]');
  function filters() {
    return { p_from: form.elements.from.value || null, p_to: form.elements.to.value || null, p_owner: form.elements.owner.value || null, p_source: form.elements.source.value || null, p_status: form.elements.status.value || null };
  }
  const unapplied = () => JSON.stringify(filters()) !== JSON.stringify(applied);
  function buttons() {
    if (!current()) return;
    container.querySelector('[data-hbt-prev]').disabled = loading || offset === 0;
    container.querySelector('[data-hbt-next]').disabled = loading || offset + result.rows.length >= result.total;
    container.querySelector('[data-hbt-export]').disabled = loading || exporting || unapplied() || result.total === 0;
    container.querySelector('[data-hbt-export]').textContent = exporting ? 'Preparing export...' : 'Export filtered CSV';
  }
  function cancelExport() { exportGeneration++; exporting = false; }
  function setOwners(owners) {
    const select = form.elements.owner, selected = select.value;
    select.replaceChildren(new Option('All authorized interns', ''));
    for (const owner of owners) select.add(new Option(owner.name || 'Name not recorded', owner.id));
    if (selected && !owners.some(owner => owner.id === selected)) select.add(new Option('Selected owner - not in this result', selected));
    select.value = selected;
  }
  async function query(snapshot, start, limit) {
    const response = await getSupabase().rpc('hopebot_feedback_tracker', { ...snapshot, p_offset: start, p_limit: limit });
    if (response?.error) throw response.error;
    return readResult(response?.data, start, limit);
  }
  function field(name, value) { return `<div><dt>${name}</dt><dd>${sanitize(value)}</dd></div>`; }
  function paintRows(seq) {
    rowsHost.innerHTML = result.rows.length ? result.rows.map((row, index) => `<article class="card hbf-row" data-hbt-row="${index}">
      <div class="hbf-row-header"><strong>${sanitize(SOURCES[row.source])}</strong><span class="badge badge-neutral">${sanitize(STATES[row.work_status] || label(row.work_status, 'Work state not recorded'))}</span></div>
      <dl class="hbf-row-fields">${field('Patient ID', row.patient_code || row.patient_id || 'Unlinked - no verified Patient ID')}${field('Patient Name', row.patient_name || 'Name not recorded')}${field('HopeBot features used', featureText(row))}${field('Feedback', row.feedback || 'Not recorded')}${field('Date', row.date_text || 'Date not recorded')}${field('Intern Assigned', row.owner_name || 'Not recorded')}${field('Current owner', row.current_owner_name || 'Not verified')}${field('Current call status', label(row.call_status, 'No saved call status'))}${field('Follow-up / due', (STATES[row.work_status] || label(row.work_status, 'Not recorded')) + (row.due_day ? ' - ' + row.due_day : ' - due date not recorded'))}${field('Identity review', label(row.identity_status, 'Not reviewed'))}${field('Reported usage', row.usage === 'yes' ? 'Yes' : row.usage === 'no' ? 'No' : 'Not asked / unknown')}${row.other ? field('Other purpose', row.other) : ''}</dl>
      ${row.source_patient_id ? field('Source Patient ID (unverified until linked)', row.source_patient_id) : ''}
      ${row.call_id && ['patient_call', 'lead_call'].includes(row.call_kind) ? '<button type="button" class="btn btn-secondary" data-hbt-call>Saved call feedback</button>' : '<p class="due-meta">No verified saved-call anchor is available here. Source history or activity alone is not a call report.</p>'}
      ${row.source === 'imported_history' && row.identity_status !== 'verified' ? '<button type="button" class="btn btn-secondary" data-hbt-link>Review patient link</button>' : ''}</article>`).join('') : '<section class="card" style="padding:20px"><h3>No records match</h3><p role="status">Try different filters. An empty result does not confirm that a family has never used HopeBot.</p></section>';
    rowsHost.querySelectorAll('[data-hbt-row]').forEach(card => {
      const row = result.rows[Number(card.dataset.hbtRow)];
      card.querySelector('[data-hbt-link]')?.addEventListener('click', async () => {
        if (!active(seq)) return;
        try {
          const { mountHopebotHistoryLink } = await import('../components/hopebotHistoryLink.js');
          if (!active(seq)) return;
          closeDialog(); const body = document.createElement('div');
          let handle;
          const modal = showModal({ title: 'Review source patient link', content: body, onClose: () => { handle?.feedback?.dispose(); if (dialog === handle) dialog = null; } });
          handle = { modal, feedback: null }; dialog = handle;
          handle.feedback = mountHopebotHistoryLink(body, row, { isCurrent: () => current() && generation === seq && dialog === handle && modal.isCurrentModal() });
        } catch { if (active(seq)) message('Could not open identity review. Refresh and try again.', true); }
      });
      card.querySelector('[data-hbt-call]')?.addEventListener('click', () => {
        if (!active(seq) || !uuid(row.call_id) || !['patient_call', 'lead_call'].includes(row.call_kind)) return;
        closeDialog();
        const body = document.createElement('div');
        const explanation = document.createElement('p'); explanation.textContent = 'Feedback is linked to the real saved call. Editing it does not replace imported history or observed activity.'; body.append(explanation);
        const slot = document.createElement('div'); body.append(slot);
        let handle;
        const modal = showModal({ title: 'Saved call feedback', content: body, onClose: () => { handle?.feedback?.dispose(); if (dialog === handle) dialog = null; } });
        handle = { modal, feedback: null }; dialog = handle;
        handle.feedback = mountHopebotFeedback(slot, row.call_id, { anchorType: row.call_kind, isCurrent: () => current() && generation === seq && dialog === handle && modal.isCurrentModal() });
      });
    });
    const count = container.querySelector('[data-hbt-count]');
    count.textContent = result.total ? `${offset + (result.rows.length ? 1 : 0)}-${offset + result.rows.length} of ${result.total}` : '0 records';
    buttons();
  }
  async function load() {
    if (!active()) return;
    const seq = ++generation, snapshot = { ...applied };
    cancelExport(); closeDialog(); loading = true;
    rowsHost.innerHTML = '<section class="card" style="padding:20px"><p role="status">Loading authorized HopeBot records...</p></section>';
    container.querySelector('[data-hbt-count]').textContent = ''; buttons();
    try {
      const next = await query(snapshot, offset, PAGE_SIZE);
      if (!active(seq)) return;
      result = next; loading = false; setOwners(next.owners); paintRows(seq);
    } catch {
      if (!active(seq)) return;
      loading = false; result = { rows: [], total: 0, owners: [] };
      rowsHost.innerHTML = '<section class="card" style="padding:20px"><h3>Could not load HopeBot feedback</h3><p role="alert">The authorized records could not be confirmed. Please retry.</p><button class="btn btn-secondary" type="button" data-hbt-retry>Retry</button></section>';
      rowsHost.querySelector('[data-hbt-retry]').onclick = () => { if (active()) load(); }; buttons();
    }
  }
  async function exportRows() {
    if (!active() || loading || exporting || unapplied()) return;
    if (result.total > EXPORT_LIMIT) { message('Export refused: more than 5000 rows match. Narrow the filters; no partial CSV was downloaded.', true); return; }
    if (!result.total) { message('There are no filtered rows to export.'); return; }
    const snapshot = { ...applied }, total = result.total, screen = result.rows.map(fingerprint), revision = filterRevision, seq = generation, exportId = ++exportGeneration;
    exporting = true; buttons(); message('Preparing the complete filtered CSV...');
    const valid = () => current() && generation === seq && exportGeneration === exportId && filterRevision === revision && !unapplied();
    try {
      const all = [], seen = new Set();
      for (let start = 0; start < total; start += 100) {
        if (!valid()) return;
        const batch = await query(snapshot, start, 100);
        if (!valid()) return;
        if (batch.total !== total || batch.total > EXPORT_LIMIT || batch.rows.length !== Math.min(100, total - start)) throw new Error('Export changed or incomplete');
        for (const row of batch.rows) { if (seen.has(row.id)) throw new Error('Duplicate export row'); seen.add(row.id); all.push(row); }
      }
      if (all.length !== total || !screen.every(value => all.some(row => fingerprint(row) === value))) throw new Error('Export differs from visible data');
      if (!valid()) return;
      const columns = ['Patient ID', 'Patient Name', 'HopeBot features used', 'Feedback', 'Date', 'Intern Assigned', 'Provenance', 'Current owner', 'Current call status', 'Work status', 'Identity review', 'Due day', 'Reported usage', 'Other purpose', 'Call kind', 'Saved call ID', 'Version', 'Updated at'];
      const csv = '\uFEFF' + [columns, ...all.map(csvFields)].map(row => row.map(hopebotFeedbackCsvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      try {
        if (!valid()) return;
        const link = document.createElement('a'); link.href = url; link.download = 'hopebot-feedback-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.append(link); link.click(); link.remove(); message(`Exported ${all.length} authorized rows using the applied filters.`);
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch {
      if (valid()) message('Export refused: the filtered records changed or were incomplete. Refresh the tracker and retry. No partial CSV was downloaded.', true);
    } finally { if (current() && exportGeneration === exportId) { exporting = false; buttons(); } }
  }
  form.addEventListener('input', () => {
    if (!active()) return;
    filterRevision++; cancelExport(); buttons(); message(unapplied() ? 'Filters changed. Apply them before exporting.' : '');
  });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!active()) return;
    const next = filters();
    if (!form.reportValidity() || !validDay(next.p_from) || !validDay(next.p_to) || (next.p_from && next.p_to && next.p_from > next.p_to) || (next.p_owner && !uuid(next.p_owner)) || (next.p_source && !Object.hasOwn(SOURCES, next.p_source)) || (next.p_status && !Object.hasOwn(STATES, next.p_status))) { message('Choose valid filters with the From date no later than the To date.', true); return; }
    applied = next; offset = 0; filterRevision++; message(''); load();
  });
  form.querySelector('[data-hbt-reset]').onclick = () => { if (!active()) return; form.reset(); applied = filters(); offset = 0; filterRevision++; message(''); load(); };
  form.querySelector('[data-hbt-refresh]').onclick = () => { if (active()) { message(''); load(); } };
  form.querySelector('[data-hbt-export]').onclick = exportRows;
  container.querySelector('[data-hbt-prev]').onclick = () => { if (active() && !loading && offset) { offset = Math.max(0, offset - PAGE_SIZE); load(); } };
  container.querySelector('[data-hbt-next]').onclick = () => { if (active() && !loading && offset + result.rows.length < result.total) { offset += PAGE_SIZE; load(); } };
  subscription = getSupabase().auth?.onAuthStateChange?.((_event, session) => { if (session?.user?.id !== getCurrentUser()?.id || account !== identity()) dispose(); })?.data?.subscription;
  if (disposed) { subscription?.unsubscribe(); return controller; }
  observer = new MutationObserver(checkIdentity); observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', checkIdentity);
  await load(); return controller;
}
