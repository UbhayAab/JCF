// ============================================================
// Patient Navigator: Form referrals (Fixboard #25)
//
// Every GI referral form sent from jarurat-care.pages.dev/gi, newest first,
// with every answer the family gave. Each one is already a family in Patient
// Navigator (sql/164: a new_lead the noon build hands to a mentor, or a
// family we know, whose owner gets a flag), so this page is where the team
// sees what arrived and whether anyone has reached them yet. Row security on
// referral_forms (sql/167) is the family's own: a manager reads every
// referral and the held ones, a mentor reads those of families she can see.
// ============================================================

import { getSupabase } from '../supabase.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { formatDate, formatRelativeTime, exportToCSV } from '../utils/formatters.js';
import { isManagerOrAdmin } from '../auth.js';
import {
  REFERRAL_COLUMNS, outcomeBadge, cancerLabel, needsText, referralFieldsHTML, consentHTML, referralSearchText, referralLabel,
} from '../utils/referralForm.js';

const LIMIT = 100;
let rows = [];
let hasMore = false;
let loading = false;
let loadGeneration = 0;
let filter = 'waiting'; // waiting | all | held (managers)
let searchQ = '';
let searchTimer = null;

export async function renderReferrals(container) {
  const manager = isManagerOrAdmin();
  if (filter === 'held' && !manager) filter = 'waiting';
  // The box is drawn empty, so nothing it no longer shows may still filter; and
  // nothing from an earlier visit (or an earlier account) may be painted again.
  searchQ = '';
  rows = [];
  hasMore = false;
  clearTimeout(searchTimer);
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Form referrals</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${manager
          ? 'Every GI referral form sent from the public link, with every answer. Each one is already a family here: new families go to a caregiver mentor at noon on working days.'
          : 'GI referral forms from the families you look after, with every answer they gave.'}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${manager ? `<button class="btn btn-secondary btn-sm" id="rf-csv" title="The referrals under the filter you are looking at">${icon('download')}CSV of this list</button>` : ''}
        <button class="btn btn-secondary btn-sm" id="rf-refresh">${icon('refresh')}Refresh</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s2)">
      <div class="chip-row" id="rf-filter">
        <button type="button" class="fchip" data-f="waiting" title="The family has not been reached on a call yet">Not reached yet</button>
        <button type="button" class="fchip" data-f="all">All</button>
        ${manager ? '<button type="button" class="fchip" data-f="held" title="Past 100 new families in a day: kept, no family made">Held</button>' : ''}
      </div>
      <div class="table-search" style="max-width:420px;flex:1 1 260px">
        ${icon('search')}
        <input class="form-input" id="rf-search" type="search" autocomplete="off"
          placeholder="Name, number, city, cancer, stage" aria-label="Search referrals" />
      </div>
    </div>
    <div id="rf-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading referrals…</div></div>
    <div id="rf-history" style="margin-top:12px"></div>`;

  container.querySelector('#rf-refresh')?.addEventListener('click', () => load(container));
  container.querySelector('#rf-csv')?.addEventListener('click', downloadCSV);
  container.querySelectorAll('#rf-filter .fchip').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    paint(container);
  }));
  // Debounced: every keystroke redraws the list, too slow on a basic phone.
  container.querySelector('#rf-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQ = e.target.value.trim().toLowerCase();
      paint(container);
    }, 150);
  });
  await load(container);
}

async function load(container, more = false) {
  const generation = ++loadGeneration;
  const body = container.querySelector('#rf-body');
  const history = container.querySelector('#rf-history');
  loading = true;
  if (more) paintHistory(container);
  try {
    let query = getSupabase().from('referral_forms')
      .select(`${REFERRAL_COLUMNS}, family:patients(id, full_name, patient_code, patient_status, first_contact_at, mentor:profiles!patients_assigned_to_fkey(full_name))`)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(LIMIT + 1);
    // A cursor keeps new incoming referrals from shifting an older page's offset.
    const last = more ? rows.at(-1) : null;
    if (last) query = query.or(`created_at.lt.${last.created_at},and(created_at.eq.${last.created_at},id.lt.${last.id})`);
    const { data, error } = await query;
    if (generation !== loadGeneration || !container.isConnected) return;
    if (error) throw error;
    hasMore = (data || []).length > LIMIT;
    rows = [...(more ? rows : []), ...(data || []).slice(0, LIMIT)];
  } catch (e) {
    if (generation !== loadGeneration || !container.isConnected) return;
    loading = false;
    if (more) {
      paintHistory(container);
      history?.insertAdjacentHTML('beforeend', `<p role="status" class="due-meta wraps">Could not load older referrals: ${sanitize(e.message)}. Try again.</p>`);
    } else {
      if (body) body.innerHTML = `<div class="empty"><h4>Could not load referrals</h4><p>${sanitize(e.message)}</p></div>`;
      if (history) history.innerHTML = '';
    }
    return;
  }
  loading = false;
  paint(container);
}

function paintHistory(container) {
  const history = container.querySelector('#rf-history');
  if (!history) return;
  history.innerHTML = hasMore ? `<p class="due-meta wraps">${rows.length} referrals loaded. Filters, search and CSV use these referrals. Load older to include earlier answers, including held forms.</p>
    <button class="btn btn-secondary btn-sm" id="rf-older" ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Load older referrals'}</button>` : '';
  history.querySelector('#rf-older')?.addEventListener('click', () => load(container, true));
}

// Not reached: the family is on file and no caregiver call has connected yet
// (patients.first_contact_at, set by the call log trigger).
const waiting = (r) => r.family && !r.family.first_contact_at && !['inactive', 'deceased'].includes(r.family.patient_status);

function visible() {
  return rows
    .filter((r) => (filter === 'all' ? true : filter === 'held' ? r.outcome === 'held' : waiting(r)))
    .filter((r) => !searchQ || referralSearchText(r).includes(searchQ));
}

function paint(container) {
  const body = container.querySelector('#rf-body');
  if (!body) return;
  container.querySelectorAll('#rf-filter .fchip').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  const list = visible();
  const nWaiting = rows.filter(waiting).length;
  paintHistory(container);
  if (!list.length) {
    body.innerHTML = `<div class="card wrap-meta" style="padding:28px;text-align:center;color:var(--ink-3)">${rows.length
      ? (filter === 'waiting' && !searchQ ? `Every ${hasMore ? 'loaded ' : ''}family from the form has been reached.` : 'Nothing under this filter in the loaded referrals.')
      : 'No referral forms yet. They appear here as soon as a family sends one.'}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="due-meta wraps" style="margin-bottom:8px">${rows.length} referral${rows.length === 1 ? '' : 's'}${hasMore ? ' loaded' : ''} · ${nWaiting} not reached yet</div>
    <div style="display:flex;flex-direction:column;gap:8px">${list.map(cardHTML).join('')}</div>`;
}

const tel = (phone) => `<a class="tnum" href="tel:${sanitize(String(phone).replace(/[^\d+]/g, ''))}">${sanitize(phone)}</a>`;

function cardHTML(r) {
  const f = r.family;
  const reach = !f ? ''
    : f.first_contact_at ? `<span class="badge badge-ok">Reached ${sanitize(formatDate(f.first_contact_at))}</span>`
      : '<span class="badge badge-gold">Not reached yet</span>';
  const who = r.outcome === 'held'
    ? 'Held: more than 100 new families came from the form that day, so no family was made. A manager decides what to do with it.'
    : !f ? 'The family record is not visible to you.'
      : `${f.mentor?.full_name ? `Caregiver mentor: <strong>${sanitize(f.mentor.full_name)}</strong>.` : 'No caregiver mentor yet: the noon build hands new families out on working days.'}${
        r.outcome === 'known_family' ? " This number was already a family's, so their mentor got a flag." : ''}`;
  const phones = [`Patient ${tel(r.phone)}`, r.caregiver_phone ? `Caregiver ${tel(r.caregiver_phone)}` : 'No caregiver number'].join(' · ');
  const facts = [cancerLabel(r.cancer), r.cancer_stage ? `Stage: ${r.cancer_stage}` : 'Stage not given', r.city, r.hospital]
    .filter(Boolean).map((x) => sanitize(x)).join(' · ');
  return `
    <div class="card" style="padding:12px 14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-weight:700;overflow-wrap:anywhere">${sanitize(r.patient_name)}</span>
        ${outcomeBadge(r.outcome)}${reach}
        <span style="flex:1"></span>
        <span class="due-meta">sent ${sanitize(formatRelativeTime(r.created_at))}</span>
        ${f ? `<a class="btn btn-secondary btn-sm" href="#patients/${sanitize(f.id)}">Open family</a>` : ''}
      </div>
      <div class="due-meta wraps" style="margin-top:6px">${phones}</div>
      <div class="due-meta wraps" style="margin-top:4px;color:var(--ink-2)">${facts}</div>
      <div class="due-meta wraps" style="margin-top:4px">Help: ${sanitize(needsText(r))}</div>
      <div class="due-meta wraps" style="margin-top:4px">${who}</div>
      <details style="margin-top:8px">
        <summary class="due-meta wraps" style="cursor:pointer">Every answer on the form</summary>
        <div style="margin-top:8px">${referralFieldsHTML(r)}</div>
        ${consentHTML(r)}
      </details>
    </div>`;
}

const CSV_COLUMNS = [
  { key: 'sent', label: 'Sent' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'patient_name', label: 'Patient (as written)' },
  { key: 'phone', label: 'Patient phone' },
  { key: 'caregiver_phone', label: 'Caregiver phone' },
  { key: 'filled_by', label: 'Filled in by' },
  { key: 'city', label: 'City' },
  { key: 'hospital', label: 'Hospital' },
  { key: 'cancer', label: 'Cancer' },
  { key: 'cancer_stage', label: 'Stage (as written)' },
  { key: 'treatment', label: 'Treatment' },
  { key: 'help', label: 'Help asked for' },
  { key: 'contact_method', label: 'Contact by' },
  { key: 'lang', label: 'Form language' },
  { key: 'family_code', label: 'Family code' },
  { key: 'mentor', label: 'Caregiver mentor' },
  { key: 'reached', label: 'First reached' },
];

function downloadCSV() {
  const data = visible().map((r) => ({
    ...r,
    sent: new Date(r.created_at).toLocaleString('en-IN'),
    outcome: referralLabel('outcome', r.outcome),
    filled_by: referralLabel('filled_by', r.filled_by),
    cancer: cancerLabel(r.cancer),
    treatment: referralLabel('treatment', r.treatment),
    contact_method: referralLabel('contact', r.contact_method),
    lang: r.lang === 'en' ? 'English' : 'Hindi',
    help: needsText(r),
    family_code: r.family?.patient_code || '',
    mentor: r.family?.mentor?.full_name || '',
    reached: r.family?.first_contact_at ? formatDate(r.family.first_contact_at) : '',
  }));
  exportToCSV(data, `form_referrals_${{ waiting: 'not_reached', all: 'all', held: 'held' }[filter] || 'list'}`, CSV_COLUMNS);
}
