// ============================================================
// Patient Navigator - Analytics cohort filters
//
// One filter set, shared by every chart on the page. Pick "Gastric" once and
// all 35 charts, every story line and every download describe those 119
// patients - not the registry with one chart re-scoped.
//
// The state is a plain object of arrays ({cancer:['gastric'],...}) which is
// exactly the jsonb contract pf_ids() reads on the database side, so what the
// UI shows and what SQL filters on can never drift.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from './toast.js';
import { exportToCSV } from '../utils/formatters.js';
import { giLabel, TRAJECTORIES, PATIENT_STATUSES } from '../utils/catalog.js';

// ── What can be filtered ─────────────────────────────────────
// group -> facets, in the order a person actually thinks about a cohort:
// what cancer, who they are, what the household can absorb, where they are,
// and what we have done for them so far.
export const FILTER_GROUPS = [
  { id: 'clinical', label: 'Clinical', color: '#0C6E74',
    facets: ['cancer', 'stage', 'trajectory', 'ecog'] },
  { id: 'person', label: 'The person', color: '#C98738',
    facets: ['age_band', 'gender', 'lang', 'literacy'] },
  { id: 'household', label: 'The household', color: '#6A57A6',
    facets: ['vuln', 'economic', 'insurance', 'cg_rel', 'cg_gender'] },
  { id: 'place', label: 'Place and care', color: '#356690',
    facets: ['state', 'city', 'hospital'] },
  { id: 'ourwork', label: 'Our work with them', color: '#2E7D55',
    facets: ['mentor', 'contact', 'support', 'concern', 'assessed', 'nutrition', 'consent', 'status', 'on_file'] },
  { id: 'time', label: 'When they joined', color: '#B0433A',
    facets: ['joined_month'] },
];

export const FACET_META = {
  cancer:       { label: 'Cancer type',        hint: 'GI subtype on file' },
  stage:        { label: 'Stage',              hint: 'stage at our first contact' },
  trajectory:   { label: 'Disease path',       hint: 'curative, palliative, surveillance' },
  ecog:         { label: 'ECOG performance',   hint: 'how much of the day they are up' },
  age_band:     { label: 'Age',                hint: 'age at registration' },
  gender:       { label: 'Patient gender',     hint: '' },
  lang:         { label: 'Language spoken',    hint: 'a family can speak more than one' },
  literacy:     { label: 'Health literacy',    hint: 'how much medical language lands' },
  vuln:         { label: 'Vulnerability',      hint: 'income, insurance, dependents, distance' },
  economic:     { label: 'Economic band',      hint: '' },
  insurance:    { label: 'Insurance',          hint: '' },
  cg_rel:       { label: 'Caregiver is the',   hint: 'who answers the phone' },
  cg_gender:    { label: 'Caregiver gender',   hint: '' },
  state:        { label: 'State',              hint: 'spelling normalised' },
  city:         { label: 'City',               hint: 'spelling normalised' },
  hospital:     { label: 'Treating hospital',  hint: 'spelling normalised' },
  mentor:       { label: 'Caregiver mentor',   hint: 'who the patient is assigned to' },
  contact:      { label: 'Conversations',      hint: 'real connected calls so far' },
  support:      { label: 'Support received',   hint: 'levers actually delivered' },
  concern:      { label: 'Red flags',          hint: 'escalation queue state' },
  assessed:     { label: 'Well-being check-ins', hint: 'has any recorded score' },
  nutrition:    { label: 'Nutrition arm',      hint: 'touched by the nutrition team' },
  consent:      { label: 'Consent',            hint: 'DPDPA consent on file' },
  status:       { label: 'Lifecycle',          hint: '' },
  on_file:      { label: 'Record state',       hint: 'archived rows are excluded from the charts' },
  joined_month: { label: 'Intake month',       hint: 'the cohort they belong to' },
};

const STAGE_LABEL = { stage_i: 'Stage I', stage_ii: 'Stage II', stage_iii: 'Stage III',
  stage_iv: 'Stage IV', unknown: 'Stage not known', not_applicable: 'Not applicable' };
const ECOG_LABEL = { '0': '0 - fully active', '1': '1 - light work only', '2': '2 - up over half the day',
  '3': '3 - in bed over half the day', '4': '4 - bedbound', unknown: 'Not recorded' };
const GENDER_LABEL = { male: 'Male', female: 'Female', other: 'Other',
  prefer_not_to_say: 'Prefer not to say', unrecorded: 'Not recorded', unknown: 'Not recorded' };
const INSURANCE_LABEL = { uninsured: 'Uninsured', govt_scheme: 'Government scheme',
  insured: 'Insured', unknown: 'Not recorded' };
const ECONOMIC_LABEL = { bpl: 'Below poverty line', lower_middle: 'Lower middle',
  middle: 'Middle', upper_middle: 'Upper middle', unknown: 'Not recorded' };
const LITERACY_LABEL = { basic: 'Basic', moderate: 'Moderate', high: 'High', unknown: 'Not recorded' };
const CONSENT_LABEL = { yes: 'Consent on file', no: 'No consent yet' };

// Human label for one value of one facet.
export function valueLabel(facet, v) {
  const s = String(v);
  switch (facet) {
    case 'cancer':     return s === 'unclassified' ? 'Not yet classified' : (giLabel(s) || s);
    case 'stage':      return STAGE_LABEL[s] || s;
    case 'trajectory': return TRAJECTORIES.find(t => t.key === s)?.label || 'Not recorded';
    case 'ecog':       return ECOG_LABEL[s] || s;
    case 'gender':
    case 'cg_gender':  return GENDER_LABEL[s] || s;
    case 'insurance':  return INSURANCE_LABEL[s] || s;
    case 'economic':   return ECONOMIC_LABEL[s] || s;
    case 'literacy':   return LITERACY_LABEL[s] || s;
    case 'consent':    return CONSENT_LABEL[s] || s;
    case 'status':     return PATIENT_STATUSES.find(x => x.key === s)?.label || s;
    case 'mentor':     return s === 'unassigned' ? 'Not assigned' : (mentorName(s) || 'Unknown mentor');
    case 'joined_month': {
      const [y, m] = s.split('-');
      return new Date(Number(y), Number(m) - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }
    case 'age_band':   return s === 'Unknown' ? 'Age not recorded' : s;
    default:           return s;
  }
}

// ── State ────────────────────────────────────────────────────
const LS_KEY = 'jcf_analytics_filters';
const LS_VIEWS = 'jcf_analytics_views';
let state = {};            // { cancer:['gastric'], age_min:40, ... }
let options = {};          // facet -> [{value,n}]
let mentors = [];          // [{id, full_name, role}]
let cohort = null;         // get_filtered_cohort payload
let onChangeCb = null;
let host = null;
let panelOpen = false;
let optionsLoading = false;

function mentorName(id) { return mentors.find(m => m.id === id)?.full_name; }

// Only send keys that carry a real constraint - an empty array must not read
// as "filter to nothing" on the SQL side.
export function getFilters() {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (Array.isArray(v)) { if (v.length) out[k] = v.slice(); }
    else if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

export function filterCount() {
  return Object.values(getFilters()).reduce((a, v) => a + (Array.isArray(v) ? v.length : 1), 0);
}

export function isFiltered() { return filterCount() > 0; }

export function cohortStats() { return cohort; }

// A short human sentence, used in exports and in the printed cohort line.
export function filterSummary() {
  const f = getFilters();
  const bits = [];
  for (const g of FILTER_GROUPS) {
    for (const facet of g.facets) {
      if (!f[facet]) continue;
      bits.push(`${FACET_META[facet].label}: ${f[facet].map(v => valueLabel(facet, v)).join(' or ')}`);
    }
  }
  if (f.age_min || f.age_max) bits.push(`Age ${f.age_min || 0} to ${f.age_max || 120}`);
  if (f.joined_from || f.joined_to) bits.push(`Joined ${f.joined_from || 'start'} to ${f.joined_to || 'today'}`);
  return bits.length ? bits.join(' · ') : 'All patients, no filter';
}

// ── Persistence: localStorage for stickiness, hash for sharing ──
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}
function loadLocal() {
  try {
    const fromHash = readHash();
    if (fromHash) return fromHash;
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function readHash() {
  const q = (location.hash.split('?')[1] || '');
  if (!q) return null;
  const p = new URLSearchParams(q).get('f');
  if (!p) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch { return null; }
}
function shareLink() {
  const f = getFilters();
  const base = location.href.split('#')[0] + '#analytics';
  if (!Object.keys(f).length) return base;
  return base + '?f=' + btoa(unescape(encodeURIComponent(JSON.stringify(f))));
}

// ── Mutations ────────────────────────────────────────────────
function fire() {
  saveLocal();
  // The old counts describe the old filter, so blank them rather than show a
  // number that is quietly wrong for a second and a half.
  cohort = null;
  renderBar();
  if (panelOpen) renderPanel();
  onChangeCb?.();
  // Options and cohort are independent; running them in parallel halves the
  // wait between clicking a filter and the bar telling you what you selected.
  loadOptions();
  loadCohort();
}

export function toggleValue(facet, value, silent = false) {
  const cur = state[facet] || [];
  state[facet] = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
  if (!state[facet].length) delete state[facet];
  if (!silent) fire();
}

export function setFacet(facet, values) {
  if (!values || !values.length) delete state[facet]; else state[facet] = values.slice();
  fire();
}

export function clearAll() { state = {}; fire(); }

// Charts call this: clicking a bar or a doughnut slice filters the whole page.
export function crossFilter(facet, value) {
  if (!FACET_META[facet]) return;
  const on = (state[facet] || []).includes(value);
  toggleValue(facet, value);
  showToast(on ? `Removed ${valueLabel(facet, value)}` : `Filtered to ${valueLabel(facet, value)}`, on ? 'info' : 'success');
}

// ── Data ─────────────────────────────────────────────────────
async function loadOptions() {
  const sb = getSupabase();
  optionsLoading = true;
  try {
    const { data, error } = await sb.rpc('get_analytics_filter_options', { p_filters: getFilters() });
    if (error) throw error;
    if (!data || data.error) return;
    options = data.facets || {};
    mentors = (data.mentors || []).map(m => ({ id: m.id, full_name: m.full_name, role: m.role }));
    // Only fill in the headline counts; loadCohort owns the detail and may
    // land either side of this.
    cohort = { matched: data.matched, total: data.total, ...(cohort || {}) };
  } catch (e) { console.error('Filter options error:', e); }
  optionsLoading = false;
  renderBar();
  if (panelOpen) renderPanel();
}

async function loadCohort() {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_filtered_cohort', { p_filters: getFilters() });
    if (error) throw error;
    if (!data || data.error) return;
    cohort = { ...(cohort || {}), ...data };
    renderBar();
  } catch (e) { console.error('Cohort summary error:', e); }
}

// ── Rendering ────────────────────────────────────────────────
const fmtIN = (n) => Number(n || 0).toLocaleString('en-IN');

function chipHTML(facet, value) {
  return `<button class="af-chip" data-off="${facet}|${encodeURIComponent(value)}" title="Remove this filter">
    <span class="af-chip-k">${FACET_META[facet].label}</span>${valueLabel(facet, value)}
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
  </button>`;
}

function renderBar() {
  const bar = host?.querySelector('#af-bar');
  if (!bar) return;
  const f = getFilters();
  const n = filterCount();
  const chips = [];
  for (const g of FILTER_GROUPS) for (const facet of g.facets) {
    (f[facet] || []).forEach(v => chips.push(chipHTML(facet, v)));
  }
  if (f.age_min || f.age_max) chips.push(`<button class="af-chip" data-off="age|"><span class="af-chip-k">Age</span>${f.age_min || 0} to ${f.age_max || 120}<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`);

  const matched = cohort?.matched, total = cohort?.total;
  const shown = matched != null && total != null;
  const pctShown = shown && total ? Math.round((matched / total) * 100) : 0;

  bar.innerHTML = `
    <div class="af-row">
      <button id="af-toggle" class="af-open ${n ? 'on' : ''}" aria-expanded="${panelOpen}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>
        ${n ? `${n} filter${n === 1 ? '' : 's'}` : 'Filter the cohort'}
        <svg class="af-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(${panelOpen ? 180 : 0}deg)"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="af-chips">${chips.join('') || '<span class="af-none">No filter - every patient on file</span>'}</div>
      ${n ? '<button id="af-clear" class="af-mini" title="Remove every filter">Clear all</button>' : ''}
      <div class="af-actions">
        <button id="af-share" class="af-mini" title="Copy a link that opens this exact filtered view">Copy link</button>
        <button id="af-save" class="af-mini" title="Save this filter set to reuse later">Save view</button>
        <button id="af-dl" class="af-mini af-mini-solid" title="Download these patients as a CSV">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download cohort
        </button>
      </div>
    </div>
    <div class="af-cohort">
      ${shown ? `<strong>${fmtIN(matched)}</strong> of ${fmtIN(total)} patients${n ? ` <span class="af-pct">${pctShown}% of the registry</span>` : ''}` : 'Counting the cohort...'}
      ${cohort?.live_rows != null && cohort.live_rows !== matched
        ? `<span class="af-dot"></span><span title="Archived records are kept for audit but left out of every chart, so chart totals stop at this number.">${fmtIN(cohort.live_rows)} live · ${fmtIN(matched - cohort.live_rows)} archived</span>` : ''}
      ${cohort?.calls != null ? `<span class="af-dot"></span>${fmtIN(cohort.calls)} calls · ${fmtIN(cohort.connected)} connected` : ''}
      ${cohort?.levers != null ? `<span class="af-dot"></span>${fmtIN(cohort.levers)} support levers` : ''}
      ${cohort?.open_concerns ? `<span class="af-dot"></span><span style="color:#B0433A">${fmtIN(cohort.open_concerns)} open concerns</span>` : ''}
      ${cohort?.no_support ? `<span class="af-dot"></span>${fmtIN(cohort.no_support)} with no support yet` : ''}
    </div>
    ${savedViewsHTML()}`;

  bar.querySelector('#af-toggle')?.addEventListener('click', () => { panelOpen = !panelOpen; renderBar(); renderPanel(); });
  bar.querySelector('#af-clear')?.addEventListener('click', clearAll);
  bar.querySelector('#af-dl')?.addEventListener('click', downloadCohort);
  bar.querySelector('#af-share')?.addEventListener('click', () => {
    const link = shareLink();
    navigator.clipboard?.writeText(link).then(
      () => showToast('Link copied - it opens with these exact filters', 'success'),
      () => showToast(link, 'info'));
  });
  bar.querySelector('#af-save')?.addEventListener('click', saveCurrentView);
  bar.querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', () => {
    const [facet, raw] = b.dataset.off.split('|');
    if (facet === 'age') { delete state.age_min; delete state.age_max; fire(); return; }
    toggleValue(facet, decodeURIComponent(raw));
  }));
  bar.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    const v = savedViews().find(x => x.name === b.dataset.view);
    if (v) { state = JSON.parse(JSON.stringify(v.filters)); fire(); }
  }));
  bar.querySelectorAll('[data-viewdel]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    localStorage.setItem(LS_VIEWS, JSON.stringify(savedViews().filter(x => x.name !== b.dataset.viewdel)));
    renderBar();
  }));
}

function savedViews() {
  try { return JSON.parse(localStorage.getItem(LS_VIEWS) || '[]'); } catch { return []; }
}
function savedViewsHTML() {
  const v = savedViews();
  if (!v.length) return '';
  return `<div class="af-views"><span class="af-views-k">SAVED VIEWS</span>${v.map(x =>
    `<span class="af-view"><button data-view="${x.name}" title="${Object.keys(x.filters).length} filters">${x.name}</button><button data-viewdel="${x.name}" title="Forget this view">&times;</button></span>`).join('')}</div>`;
}
function saveCurrentView() {
  if (!isFiltered()) { showToast('Pick some filters first', 'warning'); return; }
  const name = prompt('Name this view (for example: Stage IV, no support yet)');
  if (!name) return;
  const views = savedViews().filter(v => v.name !== name);
  views.unshift({ name: name.slice(0, 40), filters: getFilters() });
  localStorage.setItem(LS_VIEWS, JSON.stringify(views.slice(0, 8)));
  renderBar();
  showToast('View saved', 'success');
}

// One facet card. Long lists get their own search box and scroll.
function facetHTML(facet, color) {
  const opts = options[facet] || [];
  const sel = state[facet] || [];
  const meta = FACET_META[facet];
  const total = opts.reduce((a, o) => a + Number(o.n), 0);
  const long = opts.length > 7;
  const rows = opts.map(o => {
    const on = sel.includes(String(o.value));
    const share = total ? Math.round((Number(o.n) / total) * 100) : 0;
    return `<button class="af-opt ${on ? 'on' : ''}" data-pick="${facet}|${encodeURIComponent(o.value)}" data-search="${String(valueLabel(facet, o.value)).toLowerCase()}">
      <span class="af-box">${on ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span>
      <span class="af-opt-l">${valueLabel(facet, o.value)}</span>
      <span class="af-opt-n">${fmtIN(o.n)}</span>
      <span class="af-opt-bar" style="width:${share}%;background:${color}"></span>
    </button>`;
  }).join('');
  return `
    <div class="af-facet" data-facet="${facet}">
      <div class="af-facet-h">
        <span class="af-facet-t" title="${meta.hint}">${meta.label}</span>
        ${sel.length ? `<button class="af-facet-x" data-clearfacet="${facet}">clear ${sel.length}</button>` : ''}
      </div>
      ${long ? `<input class="af-search" data-searchfor="${facet}" placeholder="Search ${opts.length} options" />` : ''}
      <div class="af-opts ${long ? 'tall' : ''}">${rows || '<div class="af-empty">Nothing in this cohort</div>'}</div>
    </div>`;
}

function renderPanel() {
  const panel = host?.querySelector('#af-panel');
  if (!panel) return;
  if (!panelOpen) { panel.innerHTML = ''; panel.style.display = 'none'; return; }
  panel.style.display = '';
  if (optionsLoading && !Object.keys(options).length) {
    panel.innerHTML = '<div class="af-loading">Reading the registry...</div>';
    return;
  }
  panel.innerHTML = FILTER_GROUPS.map(g => `
    <section class="af-group">
      <div class="af-group-h"><span class="af-group-dot" style="background:${g.color}"></span>${g.label}</div>
      <div class="af-grid">${g.facets.map(f => facetHTML(f, g.color)).join('')}</div>
    </section>`).join('') + `
    <section class="af-group">
      <div class="af-group-h"><span class="af-group-dot" style="background:#7B8783"></span>Exact ranges</div>
      <div class="af-grid">
        <div class="af-facet">
          <div class="af-facet-h"><span class="af-facet-t">Age between</span></div>
          <div class="af-range">
            <input type="number" id="af-agemin" min="0" max="120" placeholder="any" value="${state.age_min ?? ''}" />
            <span>to</span>
            <input type="number" id="af-agemax" min="0" max="120" placeholder="any" value="${state.age_max ?? ''}" />
          </div>
        </div>
        <div class="af-facet">
          <div class="af-facet-h"><span class="af-facet-t">Registered between</span></div>
          <div class="af-range">
            <input type="date" id="af-from" value="${state.joined_from || ''}" />
            <span>to</span>
            <input type="date" id="af-to" value="${state.joined_to || ''}" />
          </div>
        </div>
      </div>
    </section>`;

  panel.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const [facet, raw] = b.dataset.pick.split('|');
    toggleValue(facet, decodeURIComponent(raw));
  }));
  panel.querySelectorAll('[data-clearfacet]').forEach(b => b.addEventListener('click', () => setFacet(b.dataset.clearfacet, [])));
  panel.querySelectorAll('[data-searchfor]').forEach(inp => inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    inp.closest('.af-facet').querySelectorAll('.af-opt').forEach(o => {
      o.style.display = !q || o.dataset.search.includes(q) ? '' : 'none';
    });
  }));
  const num = (el) => el.value === '' ? null : Number(el.value);
  const commit = () => {
    const mn = num(panel.querySelector('#af-agemin')), mx = num(panel.querySelector('#af-agemax'));
    const df = panel.querySelector('#af-from').value, dt = panel.querySelector('#af-to').value;
    if (mn == null) delete state.age_min; else state.age_min = mn;
    if (mx == null) delete state.age_max; else state.age_max = mx;
    if (!df) delete state.joined_from; else state.joined_from = df;
    if (!dt) delete state.joined_to; else state.joined_to = dt;
    fire();
  };
  ['#af-agemin', '#af-agemax', '#af-from', '#af-to'].forEach(sel =>
    panel.querySelector(sel)?.addEventListener('change', commit));
}

// ── Download exactly what is on screen ───────────────────────
async function downloadCohort() {
  const sb = getSupabase();
  try {
    showToast('Preparing the cohort...', 'info');
    const { data, error } = await sb.rpc('export_filtered_patients', { p_filters: getFilters() });
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { showToast('No patients match these filters', 'warning'); return; }
    exportToCSV(rows.map(r => ({ ...r, cancer: valueLabel('cancer', r.cancer), stage: valueLabel('stage', r.stage) })),
      'cohort', [
        { label: 'Patient code', key: 'patient_code' },
        { label: 'Name', key: 'full_name' },
        { label: 'Cancer type', key: 'cancer' },
        { label: 'Stage', key: 'stage' },
        { label: 'Lifecycle', key: 'status' },
        { label: 'Disease path', key: 'trajectory' },
        { label: 'ECOG', key: 'ecog' },
        { label: 'Age', key: 'age' },
        { label: 'Age band', key: 'age_band' },
        { label: 'Gender', key: 'gender' },
        { label: 'State', key: 'state' },
        { label: 'City', key: 'city' },
        { label: 'Hospital', key: 'hospital' },
        { label: 'Insurance', key: 'insurance' },
        { label: 'Economic band', key: 'economic' },
        { label: 'Vulnerability', key: 'vuln' },
        { label: 'Health literacy', key: 'literacy' },
        { label: 'Languages', key: 'languages' },
        { label: 'Caregiver is the', key: 'cg_rel' },
        { label: 'Caregiver gender', key: 'cg_gender' },
        { label: 'Consent', key: 'consent' },
        { label: 'Caregiver mentor', key: 'mentor' },
        { label: 'Calls', key: 'calls_n' },
        { label: 'Connected calls', key: 'connected_n' },
        { label: 'Conversation depth', key: 'contact' },
        { label: 'Support levers delivered', key: 'levers_n' },
        { label: 'Support band', key: 'support' },
        { label: 'Aid amount', key: 'aid_amount' },
        { label: 'Red flags', key: 'concern' },
        { label: 'Well-being check-ins', key: 'assessed' },
        { label: 'Nutrition arm', key: 'nutrition' },
        { label: 'Registered on', key: 'joined_on' },
        { label: 'Last call', key: 'last_call_at' },
      ]);
    showToast(`Exported ${rows.length} patients`, 'success');
  } catch (e) { showToast('Download failed: ' + e.message, 'error'); }
}

// ── Mount ────────────────────────────────────────────────────
export function mountAnalyticsFilters(container, { onChange } = {}) {
  host = container;
  onChangeCb = onChange;
  state = loadLocal();
  panelOpen = false;
  container.innerHTML = `<div class="af-wrap"><div id="af-bar"></div><div id="af-panel" style="display:none"></div></div>`;
  renderBar();
  // Returns once the cohort headline is on screen. The page awaits this before
  // firing its 34 chart queries, so the first thing you can read is WHICH
  // patients the page is about - not a number with no subject.
  const ready = loadCohort();
  loadOptions();
  return ready;
}

export function teardownAnalyticsFilters() { host = null; onChangeCb = null; }
