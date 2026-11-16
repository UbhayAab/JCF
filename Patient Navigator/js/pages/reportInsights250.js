// ============================================================
// Report insights (Fixboard #250). Restricted to the accounts sql/255 lists
// in focus_access250; every function refuses anyone else, and the page also
// requires the person's own login (never "Open as").
//
// Three views:
//   By area      report sharing by state, city, hospital and GI subtype
//   Checklist    per patient, the latest date of each kind of report
//   Timeline     one patient's extracted values and reports by date
// Opening a timeline writes one audit row (VIEW_REPORT_INSIGHTS).
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { reportType234 } from '../components/reportHistory234.js';

export const KINDS250 = [
  ['blood_count', 'Blood count'], ['biochemistry', 'Liver and kidney'], ['tumour_markers', 'Tumour markers'],
  ['imaging', 'CT, MRI or ultrasound'], ['pet_ct', 'PET-CT'], ['pathology', 'Biopsy'], ['ihc', 'IHC biomarkers'],
  ['molecular', 'NGS or molecular'], ['endoscopy', 'Endoscopy'], ['discharge', 'Discharge summary'],
  ['treatment_plan', 'Treatment plan'], ['weight', 'Weight'], ['other_lab', 'Other lab tests'],
];
const CHECK_COLUMNS = ['blood_count', 'biochemistry', 'tumour_markers', 'imaging', 'pet_ct', 'pathology', 'ihc', 'molecular', 'endoscopy', 'weight'];
export const SERIES250 = {
  hb: 'Haemoglobin', wbc: 'White cells', platelets: 'Platelets', anc: 'Neutrophils (absolute)', neutrophils_pct: 'Neutrophils %',
  cea: 'CEA', ca199: 'CA 19-9', bilirubin: 'Bilirubin (total)', albumin: 'Albumin', creatinine: 'Creatinine',
};
const PATHOLOGY_KINDS = { histopathology: 'Biopsy (histopathology)', cytology: 'Cytology', frozen_section: 'Frozen section', addendum: 'Addendum', supplementary: 'Supplementary report' };
const DIRECTIONS = [['increased', 'grew'], ['new', 'new'], ['stable', 'stable'], ['decreased', 'shrank'], ['resolved', 'resolved']];
const kindLabel = (k) => (KINDS250.find(([key]) => key === k) || [k, k])[1];
const n = (x) => Number(x || 0).toLocaleString('en-IN');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function todayIST() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((t) => p.find((x) => x.type === t).value).join('-');
}
const daysAgo = (days) => new Date(Date.parse(todayIST() + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
export function day250(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d\d-\d\d/.test(d)) return '-';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d.slice(0, 10) + 'T00:00:00Z'));
}
function ownLogin() {
  const u = getCurrentUser(), p = getRealProfile();
  return !!u?.id && p?.id === u.id && getCurrentProfile()?.id === u.id && !isImpersonating() && p.is_active === true
    && ['admin', 'manager'].includes(p.role) && (!p.ends_on || p.ends_on >= todayIST());
}
async function read(fn, args) {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) { const e = new Error(error.message); e.code = error.code; throw e; }
  if (!data || data.version !== 1 || data.actor_id !== getCurrentUser()?.id) throw new Error('The answer was not for this account. Refresh the page.');
  return data;
}
const failText = (e) => e?.code === '42501'
  ? 'Report insights are limited to named accounts. Sign in with your own account; ask Ubhay if yours should be added.'
  : e?.code === '22023' ? 'Choose a period of up to two years that ends today or earlier, then Apply.'
  : 'Report insights could not be loaded. Check your connection and refresh.';

function table(heads, rows, empty, wide = false) {
  if (!rows.length) return `<p class="ri250-empty">${sanitize(empty)}</p>`;
  return `<div class="ri250-table${wide ? ' ri250-wide' : ''}" tabindex="0" role="region" aria-label="Scrollable table"><table>
    <thead><tr>${heads.map((h) => `<th scope="col">${sanitize(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const stat = (label, value, note) => `<article class="card ri250-stat"><h3>${sanitize(label)}</h3><strong>${n(value)}</strong><p>${sanitize(note)}</p></article>`;

// A small dated line chart. The table under it carries the same numbers.
export function sparkline250(label, unit, points, labRange = true) {
  const pts = points.filter((p) => Number.isFinite(Number(p.value)) && /^\d{4}-\d\d-\d\d/.test(p.date || ''));
  if (!pts.length) return '';
  const W = 300, H = 90, P = 10;
  const xs = pts.map((p) => Date.parse(p.date.slice(0, 10)));
  const ys = pts.map((p) => Number(p.value));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const x = (v) => x1 === x0 ? W / 2 : P + ((v - x0) / (x1 - x0)) * (W - 2 * P);
  const y = (v) => y1 === y0 ? H / 2 : H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);
  const coords = pts.map((p, i) => `${x(xs[i]).toFixed(1)},${y(ys[i]).toFixed(1)}`);
  const last = pts[pts.length - 1];
  const summary = `${label}: ${pts.length} results from ${day250(pts[0].date)} to ${day250(last.date)}, latest ${last.value} ${unit || ''}`.trim();
  return `<figure class="card ri250-chart">
    <figcaption><strong>${sanitize(label)}</strong> <span>${sanitize(String(last.value))} ${sanitize(unit || '')} on ${sanitize(day250(last.date))}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${sanitize(summary)}" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--brand, #0f766e)" stroke-width="2" points="${coords.join(' ')}"/>
      ${pts.map((p, i) => `<circle cx="${x(xs[i]).toFixed(1)}" cy="${y(ys[i]).toFixed(1)}" r="3" fill="${['low', 'high', 'abnormal'].includes(p.flag) ? 'var(--danger, #b91c1c)' : 'var(--brand, #0f766e)'}"><title>${sanitize(day250(p.date))}: ${sanitize(String(p.value))}</title></circle>`).join('')}
    </svg>
    <p class="ri250-range">Lowest ${sanitize(String(y0))}, highest ${sanitize(String(y1))}${unit ? ' ' + sanitize(unit) : ''}.${labRange ? " Red dots are outside the lab's range." : ''}</p>
  </figure>`;
}

export async function renderReportInsights250(container) {
  const route = window.location.hash;
  const params = new URLSearchParams(route.split('?')[1] || '');
  let view = ['area', 'checklist', 'timeline'].includes(params.get('tab')) ? params.get('tab') : 'area';
  let generation = 0;
  const live = (g) => g === generation && container.isConnected && window.location.hash.startsWith('#report-insights') && ownLogin();

  if (!ownLogin()) {
    container.innerHTML = `<section class="card" style="padding:20px"><h1>Report insights</h1>
      <p role="status">Report insights open only on your own signed-in account, not through Open as.</p></section>`;
    return;
  }
  container.innerHTML = `<section class="ri250">
    <style>
      .ri250{min-width:0;overflow-wrap:anywhere}
      .ri250 .page-header{gap:12px;flex-wrap:wrap}
      .ri250-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}
      .ri250-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 14px}
      .ri250-stat{padding:16px;min-width:0}.ri250-stat h3{font-size:13px;margin:0 0 8px}.ri250-stat strong{font-size:26px;display:block}.ri250-stat p{font-size:12px;color:var(--ink-3);margin:6px 0 0}
      .ri250-section{padding:16px;margin:0 0 14px;min-width:0}.ri250-section h2{font-size:16px;margin:0 0 10px}
      .ri250-table{overflow:auto;max-width:100%}.ri250-table table{width:100%;border-collapse:collapse;font-size:13px;overflow-wrap:normal}
      .ri250-table th,.ri250-table td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
      .ri250-wide table{min-width:760px}
      .ri250-form{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:12px;margin:0 0 14px}
      .ri250-form label{display:flex;flex-direction:column;font-size:12px;gap:4px;min-width:0}
      .ri250-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:0 0 14px}
      .ri250-chart{padding:12px;margin:0}.ri250-chart svg{width:100%;height:90px;display:block}.ri250-chart figcaption{font-size:13px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
      .ri250-range,.ri250-empty,.ri250-note{font-size:12px;color:var(--ink-3)}
      .ri250-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
      .ri250-chip{border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px}
      .ri250-chip.missing{color:var(--ink-3);border-style:dashed}
      .ri250-grew{color:var(--danger,#b91c1c);font-weight:600}
      .ri250-scan{border-top:1px solid var(--line);padding:10px 0;font-size:13px}.ri250-scan:first-of-type{border-top:0}
      .ri250-scan h3{font-size:14px;margin:0 0 4px}.ri250-scan p{margin:4px 0}
    </style>
    <div class="page-header"><div><h1>Report insights</h1>
      <p class="header-subtitle">Restricted to named accounts. Opening a patient's timeline is recorded in the audit log.</p></div></div>
    <div class="ri250-tabs" role="group" aria-label="Report insights view">
      <button type="button" class="btn btn-sm" data-view="area">By area</button>
      <button type="button" class="btn btn-sm" data-view="checklist">Checklist</button>
      <button type="button" class="btn btn-sm" data-view="timeline">Patient timeline</button>
    </div>
    <p role="status" aria-live="polite" class="ri250-note" data-message></p>
    <div data-body></div>
  </section>`;
  const root = container.firstElementChild;
  const body = root.querySelector('[data-body]'), message = root.querySelector('[data-message]');
  const tabs = [...root.querySelectorAll('[data-view]')];
  const paintTabs = () => tabs.forEach((b) => {
    const on = b.dataset.view === view;
    b.className = 'btn btn-sm ' + (on ? 'btn-primary' : 'btn-secondary');
    b.setAttribute('aria-pressed', String(on));
  });
  const state = { from: daysAgo(89), to: todayIST(), search: '', area: '', offset: 0, patient: UUID.test(params.get('patient') || '') ? params.get('patient') : null };
  if (state.patient && view !== 'timeline') view = 'timeline';

  async function showArea() {
    const g = ++generation;
    body.innerHTML = `<form class="card ri250-form" data-range>
      <label>From<input class="form-input" type="date" name="from" value="${state.from}" max="${todayIST()}" required></label>
      <label>To<input class="form-input" type="date" name="to" value="${state.to}" max="${todayIST()}" required></label>
      <button class="btn btn-primary btn-sm" type="submit">Apply</button>
      ${[[29, '30 days'], [89, '90 days'], [364, '1 year']].map(([d, l]) => `<button class="btn btn-ghost btn-sm" type="button" data-days="${d}">${l}</button>`).join('')}
    </form><div data-area></div>`;
    const form = body.querySelector('[data-range]'), host = body.querySelector('[data-area]');
    form.addEventListener('submit', (e) => { e.preventDefault(); state.from = form.elements.from.value; state.to = form.elements.to.value; showArea(); });
    form.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { state.from = daysAgo(Number(b.dataset.days)); state.to = todayIST(); showArea(); }));
    message.textContent = 'Loading report sharing...';
    try {
      const d = await read('report_insights250_overview', { p_from: state.from, p_to: state.to });
      if (!live(g)) return;
      const t = d.totals;
      const areaRows = (list) => list.map((r) => [sanitize(r.label), n(r.patients), n(r.papers), n(r.originals), sanitize(day250((r.last_at || '').slice(0, 10)))]);
      const heads = ['Area', 'Patients sharing', 'Papers filed', 'WhatsApp files', 'Latest'];
      const kinds = KINDS250.map(([k, label]) => { const x = d.kinds.find((y) => y.kind === k); return [sanitize(label), n(x?.dated), n(x?.patients)]; });
      const lesionTotal = DIRECTIONS.reduce((s, [k]) => s + (d.lesions[k] || 0), 0);
      host.innerHTML = `<div class="ri250-grid">
          ${stat('Patients sharing reports', t.sharing_patients, 'Filed a paper or sent a WhatsApp file in this period.')}
          ${stat('Papers filed', t.papers, 'Reports filed into Navigator in this period.')}
          ${stat('WhatsApp files received', t.originals, 'Files families sent to HopeBot in this period.')}
          ${stat('Patients with extracted data', t.patients_with_extracted_data, `Of ${n(t.patients_in_scope)} consented patients, any date.`)}
        </div>
        <section class="card ri250-section"><h2>Report sharing by state</h2>${table(heads.map((h, i) => i === 0 ? 'State' : h), areaRows(d.areas), 'No report sharing in this period.')}</section>
        <section class="card ri250-section"><h2>By city (top 20)</h2>${table(heads.map((h, i) => i === 0 ? 'City, state' : h), areaRows(d.cities), 'No report sharing in this period.')}</section>
        <section class="card ri250-section"><h2>By treating hospital (top 20)</h2>${table(heads.map((h, i) => i === 0 ? 'Hospital' : h), areaRows(d.hospitals), 'No report sharing in this period.')}</section>
        <section class="card ri250-section"><h2>By GI cancer type</h2>${table(heads.map((h, i) => i === 0 ? 'GI type' : h), areaRows(d.subtypes), 'No report sharing in this period.')}</section>
        <section class="card ri250-section"><h2>By month</h2>${table(['Month', 'Papers filed', 'WhatsApp files'], d.months.map((m) => [sanitize(m.month), n(m.papers), n(m.originals)]), 'No months in this period.')}</section>
        <section class="card ri250-section"><h2>Extracted report content, all dates</h2>
          ${table(['Kind of report', 'Report dates', 'Patients'], kinds, 'No extracted data yet.')}
          <p class="ri250-note">Scan lesions compared with an earlier scan: ${DIRECTIONS.map(([k, l]) => `${n(d.lesions[k])} ${l}`).join(', ')}${lesionTotal ? '' : ' (none recorded)'}.</p></section>
        <details class="card ri250-section"><summary>What these numbers mean</summary>${Object.values(d.coverage).map((c) => `<p class="ri250-note">${sanitize(c)}</p>`).join('')}</details>`;
      message.textContent = `${day250(state.from)} to ${day250(state.to)}, India time.`;
    } catch (e) { if (live(g)) { host.innerHTML = ''; message.textContent = failText(e); } }
  }

  async function showChecklist() {
    const g = ++generation;
    body.innerHTML = `<form class="card ri250-form" data-find>
      <label>Patient name or code<input class="form-input" type="search" name="q" maxlength="80" value="${sanitize(state.search)}"></label>
      <label>State<select class="form-input" name="area"><option value="">All states</option></select></label>
      <button class="btn btn-primary btn-sm" type="submit">Search</button>
    </form><div data-list></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><button class="btn btn-secondary btn-sm" type="button" data-prev>Previous</button><button class="btn btn-secondary btn-sm" type="button" data-next>Next</button><span class="ri250-note" data-page></span></div>`;
    const form = body.querySelector('[data-find]'), host = body.querySelector('[data-list]');
    const prev = body.querySelector('[data-prev]'), next = body.querySelector('[data-next]');
    form.addEventListener('submit', (e) => { e.preventDefault(); state.search = form.elements.q.value.trim(); state.area = form.elements.area.value; state.offset = 0; showChecklist(); });
    prev.disabled = next.disabled = true;
    message.textContent = 'Loading the checklist...';
    try {
      const d = await read('report_insights250_checklist', { p_search: state.search || null, p_state: state.area || null, p_offset: state.offset, p_limit: 25 });
      if (!live(g)) return;
      if (!d.rows.length && state.offset > 0) { state.offset = 0; showChecklist(); return; }
      const select = form.elements.area;
      select.innerHTML = '<option value="">All states</option>' + d.states.map((s) => `<option value="${sanitize(s)}"${s === state.area ? ' selected' : ''}>${sanitize(s)}</option>`).join('');
      const rows = d.rows.map((r) => [
        `<strong>${sanitize(r.patient_name || 'Patient')}</strong>${r.patient_code ? '<br>' + sanitize(r.patient_code) : ''}<br><span class="ri250-note">${sanitize([r.city, r.state].filter(Boolean).join(', ') || 'Area not recorded')}</span>`,
        n(r.papers),
        ...CHECK_COLUMNS.map((k) => r.items[k] ? `${sanitize(day250(r.items[k].last))}<br><span class="ri250-note">${n(r.items[k].n)} ${r.items[k].n === 1 ? 'date' : 'dates'}</span>` : '<span class="ri250-note">Not on file</span>'),
        `<button class="btn btn-secondary btn-sm" type="button" data-open="${sanitize(r.patient_id)}">Timeline</button>`,
      ]);
      host.innerHTML = table(['Patient', 'Papers', ...CHECK_COLUMNS.map(kindLabel), ''], rows, 'No patients with reports match.', true)
        + '<p class="ri250-note">Each cell is the latest report date of that kind, and on how many dates that kind of report is on file. Patients with the newest reports come first.</p>';
      host.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { state.patient = b.dataset.open; view = 'timeline'; paintTabs(); showTimeline(); }));
      prev.disabled = state.offset === 0; next.disabled = !d.has_more;
      prev.onclick = () => { state.offset = Math.max(0, state.offset - 25); showChecklist(); };
      next.onclick = () => { state.offset += 25; showChecklist(); };
      body.querySelector('[data-page]').textContent = d.total ? `${state.offset + 1} to ${state.offset + d.rows.length} of ${n(d.total)} patients` : '';
      message.textContent = '';
    } catch (e) { if (live(g)) { host.innerHTML = ''; message.textContent = failText(e); } }
  }

  async function showTimeline() {
    const g = ++generation;
    if (!state.patient) {
      body.innerHTML = '<section class="card ri250-section"><p>Choose a patient from the Checklist to see their reports by date.</p></section>';
      message.textContent = '';
      return;
    }
    body.innerHTML = '';
    message.textContent = 'Loading the timeline...';
    try {
      const d = await read('report_insights250_patient', { p_patient: state.patient });
      if (!live(g)) return;
      const p = d.patient;
      const chips = KINDS250.map(([k, label]) => d.checklist[k]
        ? `<span class="ri250-chip">${sanitize(label)}: ${sanitize(day250(d.checklist[k].last))} (${n(d.checklist[k].n)} ${d.checklist[k].n === 1 ? 'date' : 'dates'})</span>`
        : `<span class="ri250-chip missing">${sanitize(label)}: not on file</span>`).join('');
      // Per test, draw the unit with the most results.
      const best = {};
      for (const s of d.series) if (!best[s.key] || s.points.length > best[s.key].points.length) best[s.key] = s;
      const charts = Object.keys(SERIES250).filter((k) => best[k]).map((k) => sparkline250(SERIES250[k], best[k].unit, best[k].points))
        .concat(d.weights.some((w) => w.weight_kg != null) ? [sparkline250('Weight', 'kg', d.weights.filter((w) => w.weight_kg != null).map((w) => ({ date: w.date, value: w.weight_kg })), false)] : []).join('');
      const lesionCell = (ls) => {
        if (!ls.length) return '<span class="ri250-note">No measured lesions</span>';
        const counts = DIRECTIONS.map(([k, l]) => [l, ls.filter((x) => x.direction === k).length]).filter(([, c]) => c);
        return counts.map(([l, c]) => `<span class="${l === 'grew' || l === 'new' ? 'ri250-grew' : ''}">${c} ${l}</span>`).join(', ')
          + '<br>' + ls.slice(0, 6).map((x) => sanitize(`${x.site || 'lesion'}: ${x.prior ?? '?'} to ${x.current ?? '?'} ${x.unit || ''}`)).join('<br>');
      };
      body.innerHTML = `<section class="card ri250-section">
          <h2>${sanitize(p.name || 'Patient')}${p.code ? ' <span class="ri250-note">' + sanitize(p.code) + '</span>' : ''}</h2>
          <p class="ri250-note">${sanitize([p.gi_subtype, p.hospital, [p.city, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'Details not recorded')}</p>
          <a class="btn btn-ghost btn-sm" href="#patients/${sanitize(p.id)}">Open patient record</a>
        </section>
        <div class="ri250-chips" aria-label="Report checklist">${chips}</div>
        ${charts ? `<div class="ri250-charts">${charts}</div>` : '<p class="ri250-note">No lab values or weights to chart yet.</p>'}
        <section class="card ri250-section"><h2>Scans and tumour change</h2>${d.scans.length ? d.scans.map((s) => `<article class="ri250-scan">
            <h3>${sanitize(day250(s.date))} · ${sanitize(s.modality || 'Scan')}</h3>
            ${s.study ? `<p class="ri250-note">${sanitize(s.study)}</p>` : ''}
            <p><strong>Compared with earlier scan${s.compared_with ? ' of ' + sanitize(day250(s.compared_with)) : ''}:</strong> ${lesionCell(s.lesions)}</p>
            ${s.impression ? `<p>${sanitize(s.impression)}</p>` : ''}</article>`).join('') : '<p class="ri250-empty">No scans extracted yet.</p>'}</section>
        <section class="card ri250-section"><h2>Biomarkers</h2>${table(['Date', 'Marker', 'Result', 'Method'],
          d.biomarkers.map((b) => [sanitize(day250(b.date)), sanitize(b.marker), sanitize([b.result, b.score].filter(Boolean).join(', ')), sanitize(b.method || 'Not stated') + (b.molecular ? ' <span class="ri250-chip">NGS / molecular</span>' : '')]),
          'No biomarkers extracted yet. NGS results appear here when a report names the method.')}</section>
        <section class="card ri250-section"><h2>Biopsy and pathology</h2>${table(['Date', 'Report', 'Diagnosis'],
          d.pathology.map((x) => [sanitize(day250(x.date)), sanitize(PATHOLOGY_KINDS[x.kind] || 'Pathology') + (x.material ? '<br><span class="ri250-note">' + sanitize(x.material) + '</span>' : ''), sanitize([x.diagnosis, x.differentiation].filter(Boolean).join('. '))]),
          'No pathology extracted yet.')}</section>
        <details class="card ri250-section"><summary>All lab values by date (${n(d.labs.length)})</summary>${table(['Date', 'Group', 'Test', 'Value', 'Range', 'Flag'],
          d.labs.map((l) => [sanitize(day250(l.date)), sanitize(kindLabel(l.kind)), sanitize(l.analyte), sanitize([l.value, l.unit].filter(Boolean).join(' ')), sanitize(l.range || ''), sanitize(l.flag || '')]),
          'No lab values extracted yet.', true)}</details>
        <details class="card ri250-section"><summary>Papers on file (${n(d.papers.length)})</summary>${table(['Report date', 'Filed', 'Type', 'Pages', 'Issued by'],
          d.papers.map((x) => [sanitize(day250(x.date)), sanitize(day250(x.filed)), sanitize(reportType234(x.type)), n(x.pages), sanitize(x.issuer || '')]),
          'No papers filed.')}</details>
        <p class="ri250-note">Lab, scan, biomarker and biopsy values come from papers a person reviewed and that are still on file; weights also include those staff typed in. Blood pressure, pulse, temperature and oxygen are not extracted.</p>`;
      message.textContent = '';
    } catch (e) { if (live(g)) { body.innerHTML = ''; message.textContent = failText(e); } }
  }

  const show = () => { paintTabs(); return view === 'area' ? showArea() : view === 'checklist' ? showChecklist() : showTimeline(); };
  tabs.forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; show(); }));
  return show();
}
