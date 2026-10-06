// ============================================================
// Patient Navigator: Data room, the cohort filter
//
// Pick a state, a city, a stage, a cancer type, and every download on the
// Datasets tab narrows to those patients. The place names are normalised
// exactly the way pf_place() does it on the database side ("west bengal",
// "West  Bengal" -> "West Bengal"), so the list you choose from here reads the
// same as the analytics cohort filter.
//
// Moved out of exports.js unchanged when the Patient canvas tab arrived, as
// the note there asked.
// ============================================================

import { icon } from '../components/icons.js';
import { valueLabel } from '../components/analyticsFilters.js';

// City and state are typed by hand on the patient form, so every value that
// reaches the dropdown is escaped: a crafted city once rendered as markup in
// the browser of whoever opened the Data room.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const F = { state: '', city: '', stage: '', cancer: '' };
let roster = [];   // one light row per patient, the filter's whole universe

export const setRoster = (rows) => { roster = rows; };

const place = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? s.replace(/(^|[^a-z])([a-z])/g, (_, a, c) => a + c.toUpperCase()) : '';
};

const FACETS = [
  { key: 'state',  label: 'State',       of: (p) => place(p.state) },
  { key: 'city',   label: 'City',        of: (p) => place(p.city) },
  { key: 'stage',  label: 'Cancer stage', of: (p) => p.cancer_stage || 'unknown', lbl: (x) => valueLabel('stage', x) },
  { key: 'cancer', label: 'Cancer type',  of: (p) => p.gi_subtype || '',          lbl: (x) => valueLabel('cancer', x) },
];

const matchesFilter = (p, f) => FACETS.every((x) => !f[x.key] || x.of(p) === f[x.key]);

export const isFiltered = () => FACETS.some((x) => F[x.key]);

// Every patient id the current filter allows: null when nothing is filtered,
// which the builders read as "no narrowing, ship the whole dataset".
export function allowedIds() {
  if (!isFiltered()) return null;
  return new Set(roster.filter((p) => matchesFilter(p, F)).map((p) => p.id));
}
// The journey and medical datasets carry patient_code, not the row id.
export function allowedCodes() {
  if (!isFiltered()) return null;
  return new Set(roster.filter((p) => matchesFilter(p, F)).map((p) => p.patient_code));
}

// Options for one dropdown, counted with that dropdown's OWN filter removed:
// otherwise picking Maharashtra leaves Maharashtra as the only state you can
// ever choose again.
function facetOptions(facet) {
  const others = { ...F, [facet.key]: '' };
  const counts = new Map();
  roster.filter((p) => matchesFilter(p, others)).forEach((p) => {
    const val = facet.of(p);
    if (!val) return;
    counts.set(val, (counts.get(val) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

// The filter, folded into the file name, so three downloads for three states
// do not all land in the folder as the same file.
export function fileSuffix() {
  const bits = FACETS.filter((x) => F[x.key]).map((x) => String(F[x.key]).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return bits.length ? '_' + bits.join('_') : '';
}

export function filterSentence() {
  const bits = FACETS.filter((x) => F[x.key]).map((x) => `${x.label}: ${x.lbl ? x.lbl(F[x.key]) : F[x.key]}`);
  return bits.join(' · ');
}

// The filter bar, drawn again on every change.
export function renderFilter(filterEl) {
  const matched = isFiltered() ? roster.filter((p) => matchesFilter(p, F)).length : roster.length;
  const selects = FACETS.map((facet) => {
    const opts = facetOptions(facet);
    const chosen = F[facet.key];
    // A value can go missing from the list once another filter narrows the
    // cohort past it; keep it selectable so the dropdown never lies about
    // what is actually filtering the downloads.
    const has = opts.some(([val]) => val === chosen);
    return `
      <label style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 180px">
        <span style="font:var(--t-xs);color:var(--ink-3)">${facet.label}</span>
        <select class="form-select" data-facet="${facet.key}">
          <option value="">All (${opts.length})</option>
          ${!has && chosen ? `<option value="${esc(chosen)}" selected>${esc(facet.lbl ? facet.lbl(chosen) : chosen)}</option>` : ''}
          ${opts.map(([val, n]) =>
            `<option value="${esc(val)}" ${val === chosen ? 'selected' : ''}>${esc(facet.lbl ? facet.lbl(val) : val)} (${n})</option>`).join('')}
        </select>
      </label>`;
  }).join('');

  filterEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
      <span style="width:17px;height:17px;display:inline-flex;flex:none;color:var(--ink-3)">${icon('filter')}</span>
      <strong style="font:var(--t-body-strong)">Filter the download</strong>
      <span style="font:var(--t-xs);color:var(--ink-3)">Pick a state or a city and every file below comes down for just those patients.</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:var(--s3);align-items:flex-end">
      ${selects}
      <button class="btn btn-ghost btn-sm" id="dr-clear" ${isFiltered() ? '' : 'disabled'} style="flex:none">Clear</button>
    </div>
    <div style="margin-top:10px;font:var(--t-xs);color:${isFiltered() ? 'var(--gold)' : 'var(--ink-3)'}">
      ${roster.length === 0 ? 'Reading the registry…'
        : isFiltered()
          ? `<strong>${matched.toLocaleString('en-IN')}</strong> of ${roster.length.toLocaleString('en-IN')} patients match: ${esc(filterSentence())}. Every download on this page is cut to these patients, including the call, session and concern files.`
          : `No filter. Every file covers all ${roster.length.toLocaleString('en-IN')} patients on file.`}
    </div>`;

  filterEl.querySelectorAll('[data-facet]').forEach((sel) => sel.addEventListener('change', () => {
    F[sel.dataset.facet] = sel.value;
    // Picking a state must not leave a city from a different state applied.
    if (sel.dataset.facet === 'state' && F.city) {
      const stillThere = roster.some((p) => matchesFilter(p, F));
      if (!stillThere) F.city = '';
    }
    renderFilter(filterEl);
  }));
  filterEl.querySelector('#dr-clear')?.addEventListener('click', () => {
    FACETS.forEach((x) => { F[x.key] = ''; });
    renderFilter(filterEl);
  });
}
