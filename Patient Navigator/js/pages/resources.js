// ============================================================
// Patient Navigator: Resource Library
//
// REWRITTEN, 10 September 2026, against the 07/09 report from Komal that
// interns are seeing patient dissatisfaction with the financial resources
// list, and the 24/08 consolidated report from Prachi on why NGO outreach
// fails.
//
// WHAT THIS PAGE USED TO DO: select * from resources where is_active, pull
// all 617 rows into the browser, and filter them in JavaScript on three
// things: a category chip, a state dropdown and a text box. The card showed
// title, summary, eligibility, phone, link and a verified badge.
//
// Everything the field reports asked to filter on was already in the
// database and on no screen: what a bed costs, whether the place only takes
// children, whether somebody has to travel there in person, whether anyone
// has ever answered the phone, what papers are demanded, and the AI read of
// the eligibility small print. None of it was rendered and none of it was
// filterable. So an intern asked for "financial resources" scrolled 617
// cards, 555 of which are commercial hotel and dormitory rooms at Rs 82 to
// Rs 1511 a night, and read out whatever came first.
//
// WHAT IT DOES NOW:
//
//   FILTERS IN POSTGRES. public.browse_resources() (sql/121) does the work.
//   The browser asks for a shelf and receives a shelf. Two round trips, not
//   617 rows.
//
//   SEPARATES CHARITY FROM A HOTEL. `aid_kind` is the axis that was
//   missing. Measured on a real patient, 76, from Bihar, treated in Mumbai:
//   579 accommodation rows, 159 after the eligibility rules, 19 once you
//   ask for the ones that cost the family nothing.
//
//   CARRIES THE PATIENT. Open it from a patient and it applies the same
//   hard rules as the WhatsApp matcher, with the same reason keys, so the
//   shelf an intern reads and the list a patient receives cannot disagree.
//   Ruled-out rows stay visible, greyed, with the reason, and can still be
//   read out: the database does not know what the mentor knows.
//
//   SAYS HOW OLD THE ANSWER IS. resource_checks has zero rows, availability
//   is 'unknown' on all 617 and nobody has ever recorded phoning a resource
//   through this app. That is not a filter, it is a hole, and the card says
//   so in words instead of implying a freshness nobody has earned. The
//   "Somebody rang them" button is the way out of it: one insert, and the
//   existing rollup trigger turns it into availability, visit_required and
//   phone_reachable for everyone.
//
//   SAYS WHO DID NOT ANSWER (sql/142, 25 Sep 2026). A family told intern
//   Vaishnavi that two organisations from the old financial PDF never picked
//   up, and nothing in the portal could hear it. Mentors now record that from
//   the patient record (js/components/resourceReport.js). An organisation a
//   family could not reach, or that turned them away, is held back from every
//   WhatsApp send, carries a banner here, and sits on "Needs re-check" until
//   somebody rings it and gets an answer. That list downloads as the CSV that
//   corrects the Sheet the PDF is built from, and a family matched here can
//   be sent from here, so the PDF stops being the way help goes out.
//
// The three patient-facing columns docs/FIELD_FEEDBACK_TRIAGE_2026-09-03.md
// section 7 said had to be settled first are settled and rendered here:
// how_to_apply, documents_needed and who_to_ask. sql/121 explains the
// decision and bridges them to the structured twins the matcher needs.
// ============================================================

import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { RESOURCE_CATEGORIES } from '../utils/catalog.js';
import { reasonLabels } from '../utils/matchReasons.js';
import { navigate } from '../router.js';
import { exportToCSV } from '../utils/formatters.js';
import { openWhatsappShare, recipientsFromPatient } from '../components/whatsappShare.js';
import {
  openResourceReport, reportSummary, loadRecheck, recheckHTML, wireRecheck, recheckCsvColumns,
} from '../components/resourceReport.js';

// ------------------------------------------------------------
// the shelves, in the order an intern needs them
// ------------------------------------------------------------
// Charity first, always. That single ordering decision is what stops a
// family who asked for help receiving a list of paid rooms.
const SHELVES = [
  { key: 'help_only',       label: 'Real help',    sub: 'Free beds, grants and schemes' },
  { key: 'charitable_stay', label: 'Free stays',   sub: 'Costs the family nothing' },
  { key: 'grant',           label: 'Grants',       sub: 'An NGO that pays towards treatment' },
  { key: 'scheme',          label: 'Govt schemes', sub: 'State and central' },
  { key: 'paid_stay',       label: 'Rooms to rent', sub: 'Hotels and dormitories, by the night' },
  { key: 'guidance',        label: 'Advice only',  sub: 'Guidance, no money and no bed' },
  { key: 'all',             label: 'Everything',   sub: 'Both shelves, nothing hidden' },
];
// Which category a shelf implies. `null` means both.
const SHELF_CATEGORY = {
  charitable_stay: null, paid_stay: 'accommodation',
  grant: 'financial_aid', scheme: 'financial_aid', guidance: 'financial_aid',
  help_only: null, all: null,
};

// Route keys that mean a shelf rather than a single aid_kind.
const COMBO = {
  // The dashboard quick action lands here. 62 rows of actual help rather
  // than 617 rows that are 90% hotel listings, with the hotels one tap away.
  money_stay: { category: null,           aid: 'help_only',       label: 'Money & stay' },
  free_help:  { category: null,           aid: 'charitable_stay', label: 'Free stays' },
  financial_aid: { category: 'financial_aid', aid: null,          label: 'Money for treatment' },
  accommodation: { category: 'accommodation', aid: null,          label: 'A place to stay' },
};

// The tags worth a chip. Every one of these came out of a field report.
const TAG_CHIPS = [
  { key: 'under_500',         label: 'Under Rs 500' },
  { key: 'attendant_allowed', label: 'Attendant can stay' },
  { key: 'has_steps',         label: 'Steps written down' },
  { key: 'smallprint_read',   label: 'Small print read' },
];
// Tags that are warnings. Ticking one HIDES those rows.
const HIDE_CHIPS = [
  { key: 'must_go_in_person',   label: 'Hide: needs a visit' },
  { key: 'children_only',       label: 'Hide: children only' },
  { key: 'phone_never_answered', label: 'Hide: phone never answered' },
];

const TAG_LABELS = {
  free_bed: 'Free', under_500: 'Under Rs 500', attendant_charged: 'Attendant is charged',
  children_only: 'Children only', minimum_age: 'Has a minimum age',
  one_gender_only: 'One gender only', residents_only: 'Residents of certain states only',
  must_go_in_person: 'Someone must go in person', papers_needed: 'Papers needed',
  needs_ration_card: 'Ration or BPL card needed', attendant_allowed: 'Attendant can stay',
  not_taking_anyone: 'Full or closed', waiting_list: 'Waiting list',
  phone_never_answered: 'Phone never answered', phone_hard_to_reach: 'Phone answered only sometimes',
  phone_gets_answered: 'Phone gets answered', no_phone_number: 'No phone number',
  never_phoned_by_us: 'Never phoned by us', too_little_known: 'Too little known',
  has_steps: 'Steps written down', smallprint_read: 'Small print read',
  family_got_no_answer: 'A family could not get through',
  family_said_it_did_not_help: 'A family said it did not help',
};
// The ones that must be read before anything else on the card.
const LOUD_TAGS = new Set(['attendant_charged', 'children_only', 'needs_ration_card',
  'must_go_in_person', 'not_taking_anyone', 'phone_never_answered', 'one_gender_only',
  'family_got_no_answer', 'family_said_it_did_not_help']);

// sql/142: the two reasons a row is HELD BACK rather than ruled out for one
// family. They are about the organisation, so they apply to everybody.
const HOLD_LABELS = {
  family_got_no_answer: 'Held back: a family could not get through',
  family_said_it_did_not_help: 'Held back: a family said it did not help',
};
const isHeld = (r) => (r.why_not || []).some((k) => HOLD_LABELS[k]);
const whyLabel = (k) => HOLD_LABELS[k] || reasonLabels([k])[0] || k;

const KIND_BADGE = {
  charitable_stay: { label: 'Free stay', tone: 'ok' },
  grant:           { label: 'Grant',     tone: 'ok' },
  scheme:          { label: 'Scheme',    tone: 'info' },
  paid_stay:       { label: 'Paid room', tone: 'neutral' },
  guidance:        { label: 'Advice',    tone: 'warn' },
};

const SCOPE_NOTE = {
  their_town:            null,
  widened_to_state:      'Nothing is recorded in the town on their record, so this is the whole state. Check the treatment city on the patient record.',
  widened_to_everything: 'Nothing is recorded anywhere near the town on their record, so this is every entry we hold, cheapest free option first. The treatment city on the record is probably a neighbourhood or a state rather than a city.',
  no_location_known:     'No treatment city on the record, so nothing was filtered by place. Ask them which hospital they attend.',
};

// ------------------------------------------------------------
// state
// ------------------------------------------------------------
const S = {
  patient: null,        // { id, full_name, age, state, treatment_city, ... }
  category: null,       // null | 'accommodation' | 'financial_aid'
  aid: null,            // null | one of SHELVES[].key
  maxInr: '',           // typed ceiling, blank means use the derived one
  tagsOn: new Set(),    // must-have tags
  tagsOff: new Set(),   // hide-these tags
  query: '',
  stateFilter: 'all',
  showRuledOut: false,
  rows: [],
  facets: null,
  scope: null,
  loading: false,
  error: null,
  // sql/142. Empty, not an error, until the migration is live.
  flags: new Map(),     // resource_id -> row of v_resource_flags
  view: 'shelf',        // 'shelf' | 'recheck'
  recheck: [],
  recheckCount: null,   // null = the re-check list does not exist yet
  recheckError: null,
};
let containerEl = null;
let reqSeq = 0;

// ------------------------------------------------------------
export async function renderResources(container, params = {}) {
  containerEl = container;

  // Deep links:
  //   #resources                       everything
  //   #resources/free_help             the free shelf
  //   #resources/money_stay            both shelves
  //   #resources/for/<patient uuid>    matched to one family
  //   #resources/free_help/for/<uuid>  both
  const parts = String(params?.id || '').split('/').filter(Boolean);
  let wantPatient = null;
  const forIx = parts.indexOf('for');
  if (forIx >= 0) { wantPatient = parts[forIx + 1] || null; parts.length = forIx; }
  const shelfKey = parts[0] || null;

  S.category = null; S.aid = null;
  // #resources/recheck opens straight onto the list the maintainers work from.
  S.view = shelfKey === 'recheck' ? 'recheck' : 'shelf';
  if (shelfKey && COMBO[shelfKey]) { S.category = COMBO[shelfKey].category; S.aid = COMBO[shelfKey].aid; }
  else if (shelfKey && SHELVES.some(s => s.key === shelfKey)) {
    S.aid = shelfKey === 'all' ? null : shelfKey;
    S.category = SHELF_CATEGORY[shelfKey] ?? null;
  }
  else if (shelfKey && RESOURCE_CATEGORIES.some(c => c.key === shelfKey)) S.category = shelfKey;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Resource Library</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Real help you can offer on a call. Free stays and grants come first; the rented rooms are behind their own chip.</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="rs-recheck" hidden>${icon('alertTriangle')}<span>Needs re-check</span></button>
        ${isManagerOrAdmin() ? `<button class="btn btn-primary btn-sm" id="rs-add">${icon('plus')}Add resource</button>` : ''}
      </div>
    </div>
    <div id="rs-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Opening the shelf…</div></div>`;
  container.querySelector('#rs-add')?.addEventListener('click', () => openResourceModal(null));
  container.querySelector('#rs-recheck')?.addEventListener('click', () => {
    navigate(S.view === 'recheck' ? 'resources' : 'resources/recheck');
  });

  // The URL is the source of truth for who this shelf is matched to. S is a
  // module-level object that outlives one render, so leaving the previous
  // family on it would silently filter the NEXT navigation by the LAST
  // patient, which is the worst possible failure here: a shelf that looks
  // right and is wrong for the person on the phone.
  if (!wantPatient) { S.patient = null; S.scope = null; }
  else if (S.patient?.id !== wantPatient) await loadPatient(wantPatient);
  await load();
}

async function loadPatient(id) {
  try {
    const { data } = await getSupabase().from('patients')
      .select('id, full_name, age, gender, state, city, treatment_city, economic_status, insurance_status, documents_asked_on')
      .eq('id', id).maybeSingle();
    S.patient = data || null;
  } catch { S.patient = null; }
}

// ------------------------------------------------------------
// data: two RPCs, never 617 rows
// ------------------------------------------------------------
async function load() {
  const sb = getSupabase();
  const body = containerEl?.querySelector('#rs-body');
  if (!body) return;
  const seq = ++reqSeq;
  S.loading = true; S.error = null;
  paint();

  const args = {
    p_patient: S.patient?.id || null,
    p_category: S.category,
    p_aid_kind: S.aid,
    p_max_inr: numOrNull(S.maxInr),
    p_city: null,
    p_state: S.stateFilter === 'all' ? null : S.stateFilter,
    p_q: S.query || null,
    p_exclude_visit: S.tagsOff.has('must_go_in_person'),
    p_limit: 200,
    p_offset: 0,
  };

  try {
    const [browse, facets, flags, recheck] = await Promise.all([
      S.view === 'shelf' ? sb.rpc('browse_resources', args) : Promise.resolve({ data: S.rows }),
      // p_category is deliberately NULL: the shelf chips are the primary
      // navigation and their counts must not change when you click one.
      S.view === 'shelf' ? sb.rpc('resource_shelf_facets', {
        p_patient: args.p_patient, p_category: null, p_q: S.query || null,
      }) : Promise.resolve({ data: S.facets }),
      // What families reported (sql/142). A handful of rows, not 617. Before
      // the migration is live this errors, and the shelf simply shows no flags.
      sb.from('v_resource_flags')
        .select('resource_id, held_back, flag, open_reports, open_reasons, recent_reports, last_open_at, last_answered_at'),
      loadRecheck().then((rows) => ({ rows }), (error) => ({ error })),
    ]);
    if (seq !== reqSeq) return;              // a newer keystroke already won
    if (browse.error) throw browse.error;
    S.rows = browse.data || [];
    S.facets = facets.error ? null : facets.data;
    S.scope = S.rows.length ? S.rows[0].scope : (S.facets?.scope || null);
    S.flags = new Map((flags.error ? [] : flags.data || []).map((f) => [f.resource_id, f]));
    S.recheck = recheck.rows || [];
    S.recheckCount = recheck.error ? null : S.recheck.length;
    S.recheckError = recheck.error ? recheck.error.message : null;
  } catch (e) {
    if (seq !== reqSeq) return;
    S.error = e.message;
    S.rows = []; S.facets = null;
  }
  S.loading = false;
  paint();
}

// ------------------------------------------------------------
// paint
// ------------------------------------------------------------
function paint() {
  const body = containerEl?.querySelector('#rs-body');
  if (!body) return;
  paintRecheckButton();
  if (S.view === 'recheck') { paintRecheck(body); return; }

  if (S.error) {
    body.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div>
      <h4>Could not open the library</h4><p>${esc(S.error)}</p>
      <p class="due-meta" style="margin-top:8px">If this says browse_resources does not exist, sql/121 has not been run against this project yet.</p></div>`;
    return;
  }

  // The client-side pass is only for the tag chips, which are cheap to
  // apply here and would otherwise cost a round trip per tick.
  const visible = S.rows.filter(r => {
    const tags = r.tags || [];
    for (const t of S.tagsOn) if (!tags.includes(t)) return false;
    for (const t of S.tagsOff) if (tags.includes(t)) return false;
    return true;
  });
  const fit = visible.filter(r => r.eligible);
  // Held back (sql/142) is about the organisation, not this family, so it
  // gets its own section, open, instead of hiding in "ruled out".
  const held = visible.filter(r => !r.eligible && isHeld(r));
  const out = visible.filter(r => !r.eligible && !isHeld(r));
  const f = S.facets || {};

  body.innerHTML = `
    <style>
      .rs-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:var(--s4)}
      .rs-shelf{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:8px 13px;border:1px solid var(--line);border-radius:var(--r-sm);background:transparent;cursor:pointer;text-align:left;transition:all .15s}
      .rs-shelf.on{border-color:var(--primary);background:var(--primary-soft)}
      .rs-shelf b{font:var(--t-body-strong);font-size:13px;color:var(--ink-1)}
      .rs-shelf span{font-size:10.5px;color:var(--ink-3);line-height:1.4}
      .rs-shelf i{font-style:normal;font-size:10.5px;color:var(--ink-3)}
      .rs-card{padding:16px 17px;display:flex;flex-direction:column;gap:9px}
      .rs-card.out{opacity:.6;border-style:dashed}
      .rs-tags{display:flex;flex-wrap:wrap;gap:4px}
      .rs-tags span{font-size:10.5px;line-height:1.55;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--ink-3)}
      .rs-tags span.loud{color:var(--warn);border-color:var(--warn)}
      .rs-tags span.bad{color:var(--danger);border-color:var(--danger)}
      .rs-slot{font:var(--t-xs);color:var(--ink-2);padding:7px 10px;background:var(--surface-2);border-radius:var(--r-sm);white-space:pre-wrap}
      .rs-slot b{color:var(--ink-1);font-weight:700}
      .rs-fresh{font-size:11px;color:var(--ink-3);display:flex;align-items:center;gap:5px}
      .rs-price{font:var(--t-body-strong);font-size:14px;color:var(--ink-1)}
      .rs-card.held{border-color:var(--danger)}
      .rs-hold{font:var(--t-xs);color:var(--ink-1);padding:8px 10px;border-radius:var(--r-sm);background:var(--danger-soft);border-left:3px solid var(--danger);line-height:1.5}
      .rs-hold b{color:var(--danger)}
      .rs-told{font:var(--t-xs);color:var(--ink-2);padding:6px 10px;border-radius:var(--r-sm);background:var(--surface-2);line-height:1.5}
    </style>

    ${patientBarHTML()}

    ${S.recheckCount ? `
      <div class="rs-hold" style="margin-bottom:var(--s4);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span style="flex:1;min-width:240px"><b>${S.recheckCount} organisation${S.recheckCount === 1 ? '' : 's'} need${S.recheckCount === 1 ? 's' : ''} a re-check.</b>
          Families could not get through, or were turned away. They are not sent to anyone until somebody rings them and gets an answer.</span>
        <button class="btn btn-secondary btn-sm" id="rs-open-recheck">${icon('phoneCall')}Open the re-check list</button>
      </div>` : ''}

    <div class="rs-chips" id="rs-shelves">
      ${SHELVES.map(s => {
        const n = shelfCount(s.key, f);
        return `<button class="rs-shelf ${((s.key === 'all' && !S.aid) || S.aid === s.key) ? 'on' : ''}" data-shelf="${s.key}">
          <b>${s.label}${n == null ? '' : ` &middot; ${n}`}</b><span>${s.sub}</span></button>`;
      }).join('')}
    </div>

    <div class="card" style="padding:13px 15px;margin-bottom:var(--s4);display:flex;gap:11px;flex-wrap:wrap;align-items:center">
      <div style="position:relative;flex:1;min-width:190px">
        <span style="position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:var(--ink-3);display:inline-flex">${icon('search')}</span>
        <input class="input" id="rs-search" placeholder="Search: city, scheme, need…" value="${esc(S.query)}" style="padding-left:34px;width:100%" />
      </div>
      <label style="display:flex;align-items:center;gap:6px;font:var(--t-xs);color:var(--ink-3)">
        <span>Up to Rs</span>
        <input class="input" id="rs-max" inputmode="numeric" placeholder="${S.patient ? 'their band' : 'any'}"
               value="${esc(S.maxInr)}" style="width:76px;padding:5px 8px;font-size:12.5px" />
        <span>a night</span>
      </label>
      <select class="select" id="rs-state" style="width:auto;min-width:140px">
        <option value="all">All states</option>
        ${(f.states || []).map(s => `<option value="${esc(s)}" ${S.stateFilter === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>

    <div class="rs-chips" id="rs-tags">
      ${TAG_CHIPS.map(c => {
        const n = tagCount(c.key);
        return n ? `<button class="fchip ${S.tagsOn.has(c.key) ? 'on' : ''}" data-tag="${c.key}">${c.label} &middot; ${n}</button>` : '';
      }).join('')}
      ${HIDE_CHIPS.map(c => {
        const n = tagCount(c.key);
        return n ? `<button class="fchip ${S.tagsOff.has(c.key) ? 'on' : ''}" data-hide="${c.key}">${c.label} &middot; ${n}</button>` : '';
      }).join('')}
    </div>

    <div class="due-meta" style="margin-bottom:var(--s4)">
      ${S.loading ? 'Working out the shelf…'
        : `<strong>${fit.length}</strong> to read out${held.length ? ` &nbsp;|&nbsp; <span style="color:var(--danger)">${held.length} held back</span>` : ''}${
            out.length ? ` &nbsp;|&nbsp; ${out.length} ruled out${S.patient ? ' for this family' : ''}` : ''}${
            totalMatching() > S.rows.length ? ` &nbsp;|&nbsp; showing ${S.rows.length} of ${totalMatching()}, narrow it with a chip` : ''}`}
    </div>

    ${fit.length === 0 && !S.loading ? `
      <div class="empty" style="padding:40px 20px">
        <div class="ico-wrap">${icon('search')}</div>
        <h4>Nothing on this shelf</h4>
        <p>${out.length || held.length ? 'Everything here was ruled out or is held back. Look at the lists below.' : 'Try a different chip, or clear the search.'}</p>
      </div>` : `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:var(--s4)">
        ${fit.map(r => card(r, false)).join('')}
      </div>`}

    ${held.length ? `
      <h3 style="font:var(--t-body-strong);font-size:15px;margin:var(--s5) 0 4px;color:var(--danger)">Held back from WhatsApp: ${held.length}</h3>
      <div class="rr-note" style="margin-bottom:var(--s3)">A family could not get through to these, or was turned away. They are not sent to anyone until somebody rings them and gets an answer.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:var(--s4)">
        ${held.map(r => card(r, true)).join('')}
      </div>` : ''}

    ${out.length ? `
      <button class="btn btn-ghost btn-sm" id="rs-toggle-out" style="margin-top:var(--s4)">
        ${S.showRuledOut ? 'Hide' : 'Show'} ${out.length} ruled out${S.patient ? ' for this family' : ''}</button>
      ${S.showRuledOut ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:var(--s4);margin-top:var(--s4)">
        ${out.map(r => card(r, true)).join('')}</div>` : ''}` : ''}`;

  wire(body);
}

const totalMatching = () => (S.rows[0]?.total_matching ?? S.rows.length);

// Counted over the rows ACTUALLY ON THIS SHELF, not over the facet totals.
// The facets describe every category so the shelf chips stay stable when you
// click one, but a tag chip is a filter: if it says 63 and ticking it leaves
// nothing, the screen has lied. "Under Rs 500" is exactly that case, because
// it only ever tags a rented room and the default shelf holds none.
function tagCount(key) {
  return S.rows.reduce((n, r) => n + (r.eligible && (r.tags || []).includes(key) ? 1 : 0), 0);
}

function shelfCount(key, f) {
  if (!f) return null;
  const by = f.by_aid_kind || {};
  if (key === 'all') return f.eligible;
  // "Real help" is everything that is not a room with a nightly rate. The
  // count has to say so out loud, because 62 sitting next to 555 is the
  // whole finding.
  if (key === 'help_only') return Object.entries(by)
    .filter(([k]) => k !== 'paid_stay').reduce((a, [, n]) => a + n, 0);
  return by[key] ?? 0;
}

function patientBarHTML() {
  if (!S.patient) {
    return `<div class="card" style="padding:11px 15px;margin-bottom:var(--s4);display:flex;align-items:center;gap:10px;border-left:4px solid var(--line)">
      <span style="width:16px;height:16px;flex:none;color:var(--ink-3);display:inline-flex">${icon('info')}</span>
      <div style="font:var(--t-xs);color:var(--ink-3);flex:1">Browsing the whole shelf. Name the family and this hides what they cannot get, and says why.</div>
      <button class="btn btn-secondary btn-sm" id="rs-pick-patient" style="padding:4px 11px;font-size:11.5px">${icon('users')}Match to a family</button>
    </div>`;
  }
  const p = S.patient;
  const bits = [];
  if (p.age != null) bits.push(`age ${p.age}`);
  if (p.gender) bits.push(esc(p.gender));
  if (p.state) bits.push(esc(p.state));
  if (p.treatment_city) bits.push(`treated in ${esc(p.treatment_city)}`);
  if (!p.documents_asked_on) bits.push(`<span style="color:var(--warn)">papers never asked</span>`);
  const note = SCOPE_NOTE[S.scope];
  const why = S.facets?.by_why_not || {};
  const whyLine = Object.entries(why).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${esc(whyLabel(k))} ${n}`).join(' &middot; ');

  return `<div class="card" style="padding:12px 15px;margin-bottom:var(--s4);border-left:4px solid var(--primary)">
    <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
      <span style="width:16px;height:16px;flex:none;color:var(--primary);display:inline-flex">${icon('handHeart')}</span>
      <div style="font:var(--t-sm);color:var(--ink-1)"><strong>${esc(p.full_name || 'This family')}</strong>
        <span style="color:var(--ink-3)"> &middot; ${bits.join(' &middot; ')}</span></div>
      <span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" id="rs-clear-patient" style="padding:3px 9px;font-size:11.5px">Browse everything instead</button>
    </div>
    ${whyLine ? `<div class="due-meta" style="margin-top:6px">Ruled out: ${whyLine}</div>` : ''}
    ${note ? `<div class="due-meta" style="margin-top:6px;color:var(--warn)">${note}</div>` : ''}
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;padding-top:9px;border-top:1px solid var(--line)">
      <button class="btn btn-gold btn-sm" id="rs-send">${icon('phone')}Send on WhatsApp</button>
      <button class="btn btn-secondary btn-sm" id="rs-report">${icon('message')}Report an NGO</button>
      <span class="rr-note" style="flex:1;min-width:220px">Send from here, not from the old PDF: organisations a family could not reach are left out automatically.</span>
    </div>
  </div>`;
}

// What families reported about this organisation (sql/142), in the mentor's
// words. Held back: loud, with the way out. Otherwise: what was said in the
// last six months, because "asks for a ration card" stays true after the
// phone is answered.
function reportedHTML(r) {
  const fl = S.flags.get(r.resource_id);
  if (!fl) return '';
  if (fl.held_back) {
    const when = fl.last_open_at ? ` Latest ${esc(shortDay(fl.last_open_at))}.` : '';
    return `<div class="rs-hold"><b>Held back from WhatsApp.</b> ${esc(reportSummary(fl.open_reasons).join('; '))}.${when}
      Ring them: if they answer, record it below and the hold lifts for everyone.</div>`;
  }
  const said = reportSummary(fl.recent_reports);
  return said.length ? `<div class="rs-told"><b>Families told us (last 6 months):</b> ${esc(said.join('; '))}.</div>` : '';
}

// ------------------------------------------------------------
// the card
// ------------------------------------------------------------
function card(r, isOut) {
  const badge = KIND_BADGE[r.aid_kind] || { label: r.aid_kind || 'Help', tone: 'neutral' };
  const place = clean([r.city, r.state].filter(Boolean).join(', '));
  const held = isHeld(r) || S.flags.get(r.resource_id)?.held_back === true;
  // The hold is said once, in the banner, not again as a tag.
  const tags = (r.tags || []).filter(t => TAG_LABELS[t] && !HOLD_LABELS[t]);
  const why = (r.why_not || []).filter(k => !HOLD_LABELS[k]);

  return `
    <div class="card rs-card ${isOut && !held ? 'out' : ''} ${held ? 'held' : ''}">
      <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
        <span class="badge badge-${badge.tone}">${badge.label}</span>
        <span class="rs-price">${priceLine(r)}</span>
        <span style="flex:1"></span>
        ${isManagerOrAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit="${r.resource_id}" title="Edit" style="padding:4px 7px">${icon('edit')}</button>` : ''}
      </div>

      <div>
        <div style="font:var(--t-body-strong);font-size:15px;line-height:1.35">${esc(clean(r.title))}</div>
        ${place ? `<div class="due-meta" style="display:flex;align-items:center;gap:5px;margin-top:3px">
          <span style="width:13px;height:13px;display:inline-flex;flex:none">${icon('mapPin')}</span>${esc(place)}</div>` : ''}
      </div>

      ${reportedHTML(r)}

      ${isOut && why.length ? `<div class="rs-tags">${why.map(k => `<span class="bad">${esc(whyLabel(k))}</span>`).join('')}</div>` : ''}

      ${tags.length ? `<div class="rs-tags">${tags
        .sort((a, b) => (LOUD_TAGS.has(b) ? 1 : 0) - (LOUD_TAGS.has(a) ? 1 : 0))
        .map(t => `<span class="${LOUD_TAGS.has(t) ? 'loud' : ''}">${TAG_LABELS[t]}</span>`).join('')}</div>` : ''}

      ${whoLine(r) ? `<div class="rs-slot"><b>Who it is for:</b> ${whoLine(r)}</div>` : ''}
      ${r.summary ? `<p style="font:var(--t-sm);color:var(--ink-2);margin:0">${esc(clean(r.summary))}</p>` : ''}

      ${r.documents_needed ? `<div class="rs-slot"><b>Papers to carry:</b> ${esc(clean(r.documents_needed))}</div>` : ''}
      ${r.how_to_apply ? `<div class="rs-slot"><b>How to apply:</b>\n${esc(clean(r.how_to_apply))}</div>` : ''}
      ${r.who_to_ask ? `<div class="rs-slot"><b>Ask for:</b> ${esc(clean(r.who_to_ask))}</div>` : ''}
      ${r.smallprint ? `<div class="rs-slot" style="border-left:3px solid var(--line)"><b>What their own page says:</b> ${esc(clean(r.smallprint))}</div>` : ''}
      ${(!r.how_to_apply && !r.documents_needed && !r.who_to_ask) ? `
        <div class="due-meta" style="color:var(--warn)">Nobody has written down how a family actually applies to this one.${
          isManagerOrAdmin() ? ' Use Edit to add the steps.' : ''}</div>` : ''}

      <div style="margin-top:auto;padding-top:9px;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${r.contact_phone ? `<a href="tel:${esc(String(r.contact_phone).replace(/\s/g, ''))}" class="btn btn-ghost btn-sm" style="gap:6px;padding:4px 8px">${icon('phone')}<span class="tnum">${esc(r.contact_phone)}</span></a>` : ''}
        ${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" style="gap:6px;padding:4px 8px">${icon('arrowRight')}Details</a>` : ''}
        <span style="flex:1"></span>
        ${S.patient ? `<button class="btn btn-ghost btn-sm" data-tried="${r.resource_id}" style="padding:4px 8px;font-size:11.5px" title="Record what happened when this family tried them">${icon('message')}Family tried this</button>` : ''}
        <button class="btn ${held ? 'btn-primary' : 'btn-ghost'} btn-sm" data-check="${r.resource_id}" style="padding:4px 8px;font-size:11.5px">${icon('phoneCall')}${held ? 'Ring them to lift the hold' : 'Somebody rang them'}</button>
      </div>
      <div class="rs-fresh">${freshLine(r)}</div>
      ${r.address ? `<div class="due-meta">${esc(clean(r.address))}</div>` : ''}
    </div>`;
}

function priceLine(r) {
  if (r.category !== 'accommodation') {
    return r.aid_kind === 'guidance' ? 'No money, no bed' : 'Amount not recorded';
  }
  const lo = numOrNull(r.amount_min_inr), hi = numOrNull(r.amount_max_inr);
  if (lo === 0) return 'Free';
  if (lo != null && hi != null && hi > lo) return `Rs ${lo} to ${hi} a night`;
  if (lo != null) return `Rs ${lo} a night`;
  return 'Cost not recorded';
}

function whoLine(r) {
  const bits = [];
  if (r.age_min != null && r.age_max != null) bits.push(`ages ${r.age_min} to ${r.age_max}`);
  else if (r.age_max != null) bits.push(`up to age ${r.age_max}`);
  else if (r.age_min != null) bits.push(`age ${r.age_min} and above`);
  if (r.attendant_inr_night > 0) bits.push(`the attendant is charged Rs ${Math.round(r.attendant_inr_night)} a night`);
  // `eligibility` is staff free text and on plenty of rows it is not a "who"
  // at all: several read "Free Accomodations", which is already the price
  // badge and the summary. Printing it under "Who it is for" makes the card
  // look like it is repeating itself, so a line that adds nothing is dropped.
  const e = (r.eligibility || '').trim();
  const said = norm([r.summary, r.smallprint].filter(Boolean).join(' '));
  if (e && !said.includes(norm(e))) bits.push(esc(clean(e)));
  return bits.join('; ');
}
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// An availability answer from six weeks ago is not evidence of a room today,
// and "verified July 2026" on 617 imported rows was a claim nobody had
// earned. This line says exactly what is and is not known.
function freshLine(r) {
  if (r.checks_logged > 0 && r.checked_days_ago != null) {
    const d = r.checked_days_ago;
    const word = d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
    const stale = d > 42;
    return `<span style="color:${stale ? 'var(--warn)' : 'var(--ok)'}">${icon('check')}</span> Somebody rang them ${word}${stale ? '. That is old enough to ring again.' : ''}`;
  }
  return `<span style="color:var(--ink-3)">${icon('info')}</span> Never phoned by us. This row came from a spreadsheet import, so nobody has confirmed it is open.`;
}

// ------------------------------------------------------------
// wiring
// ------------------------------------------------------------
function wire(body) {
  body.querySelectorAll('#rs-shelves .rs-shelf').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.shelf;
    S.aid = (k === 'all') ? null : k;
    // Picking a shelf picks its category too, so the state dropdown stops
    // describing a shelf nobody is looking at.
    S.category = SHELF_CATEGORY[k] ?? null;
    load();
  }));

  body.querySelectorAll('#rs-tags [data-tag]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.tag;
    S.tagsOn.has(k) ? S.tagsOn.delete(k) : S.tagsOn.add(k);
    paint();
  }));
  body.querySelectorAll('#rs-tags [data-hide]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.hide;
    S.tagsOff.has(k) ? S.tagsOff.delete(k) : S.tagsOff.add(k);
    // The visit filter is applied in Postgres, so that one costs a fetch.
    k === 'must_go_in_person' ? load() : paint();
  }));

  let t = null;
  body.querySelector('#rs-search')?.addEventListener('input', (e) => {
    clearTimeout(t);
    const v = e.target.value.trim();
    t = setTimeout(() => { S.query = v; load().then(focusSearch); }, 300);
  });
  let t2 = null;
  body.querySelector('#rs-max')?.addEventListener('input', (e) => {
    clearTimeout(t2);
    const v = e.target.value.replace(/[^0-9]/g, '');
    t2 = setTimeout(() => { S.maxInr = v; load(); }, 400);
  });
  body.querySelector('#rs-state')?.addEventListener('change', (e) => { S.stateFilter = e.target.value; load(); });
  body.querySelector('#rs-toggle-out')?.addEventListener('click', () => { S.showRuledOut = !S.showRuledOut; paint(); });
  body.querySelector('#rs-clear-patient')?.addEventListener('click', () => { S.patient = null; S.scope = null; load(); });
  body.querySelector('#rs-pick-patient')?.addEventListener('click', openPatientPicker);

  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    const { data } = await getSupabase().from('resources').select('*').eq('id', b.dataset.edit).maybeSingle();
    if (data) openResourceModal(data);
  }));
  body.querySelectorAll('[data-check]').forEach(b => b.addEventListener('click', () => {
    const row = S.rows.find(r => r.resource_id === b.dataset.check);
    if (row) openCheckModal(row);
  }));

  // sql/142: the family on this shelf, sent from here, and reported from here.
  body.querySelector('#rs-open-recheck')?.addEventListener('click', () => navigate('resources/recheck'));
  body.querySelector('#rs-send')?.addEventListener('click', openSendForPatient);
  body.querySelector('#rs-report')?.addEventListener('click', () =>
    openResourceReport({ patient: S.patient, onSaved: load }));
  body.querySelectorAll('[data-tried]').forEach(b => b.addEventListener('click', () => {
    const row = S.rows.find(r => r.resource_id === b.dataset.tried);
    if (row) openResourceReport({ patient: S.patient, resource: { id: row.resource_id, title: row.title, category: row.category, city: row.city, state: row.state }, onSaved: load });
  }));
}

// The WhatsApp send, from the shelf. The same component and the same Edge
// Function as the patient record, so there is one send path and it is the
// one that leaves held-back organisations out.
async function openSendForPatient() {
  if (!S.patient) return;
  const { data, error } = await getSupabase().from('patients')
    .select('id, patient_code, full_name, phone_full, caregiver_phone_full, caregiver_name')
    .eq('id', S.patient.id).maybeSingle();
  if (error || !data) { showToast('Could not open this family: ' + (error?.message || 'not found'), 'error'); return; }
  openWhatsappShare({ patient: data, recipients: recipientsFromPatient(data) });
}

// ------------------------------------------------------------
// "Needs re-check" (sql/142)
// ------------------------------------------------------------
function paintRecheckButton() {
  const b = containerEl?.querySelector('#rs-recheck');
  if (!b) return;
  // Hidden until the list exists (the migration is live), then always shown,
  // with the count, so an empty list reads as good news rather than absence.
  b.hidden = S.recheckCount == null && S.view !== 'recheck';
  b.querySelector('span').textContent = S.view === 'recheck'
    ? 'Back to the shelf'
    : `Needs re-check${S.recheckCount ? ` · ${S.recheckCount}` : ''}`;
  b.classList.toggle('btn-danger', !!S.recheckCount && S.view !== 'recheck');
  b.classList.toggle('btn-secondary', !S.recheckCount || S.view === 'recheck');
}

function paintRecheck(body) {
  const rows = S.recheck || [];
  const onShelf = rows.filter(x => x.kind === 'on_shelf').length;
  body.innerHTML = `
    <div class="card" style="padding:14px 16px;margin-bottom:var(--s4);display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;border-left:4px solid var(--danger)">
      <div style="flex:1;min-width:260px">
        <h3 style="margin:0 0 4px;font:var(--t-body-strong);font-size:16px">Needs re-check</h3>
        <div class="rr-note">Organisations a family could not reach, or that turned them away. None of them is sent to anyone until somebody rings and gets an answer.
          Ring each one and record it: an answer lifts the hold for everyone. The ones marked "not on our shelf" come from the old PDF and the Sheet it is built from; download the list, fix the Sheet, then close them here.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" id="rc-csv" ${rows.length ? '' : 'disabled'}>${icon('download')}Download for the Sheet (CSV)</button>
      </div>
    </div>
    ${S.loading ? '<div class="due-meta">Loading…</div>' : ''}
    ${S.recheckError ? `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>The re-check list is not available yet</h4>
      <p>${esc(S.recheckError)}</p><p class="due-meta">It arrives with sql/142.</p></div>` : `
      <div class="rr-note" style="margin-bottom:var(--s3)">${onShelf} held back on the shelf &nbsp;|&nbsp; ${rows.length - onShelf} named by families but not on our shelf</div>
      ${recheckHTML(rows, { isManager: isManagerOrAdmin() })}`}`;

  body.querySelector('#rc-csv')?.addEventListener('click', () =>
    exportToCSV(S.recheck, 'organisations_to_fix_in_the_sheet', recheckCsvColumns()));
  wireRecheck(body, rows, {
    onRing: (x) => openCheckModal({ resource_id: x.resource_id, title: x.organisation, contact_phone: x.contact_phone,
      tags: [], held: true }, load),
    onEdit: async (x) => {
      const { data } = await getSupabase().from('resources').select('*').eq('id', x.resource_id).maybeSingle();
      if (data) openResourceModal(data);
    },
    onAdd: (x) => openResourceModal(null, { title: x.organisation, category: 'financial_aid' }),
    onChanged: load,
  });
}

function focusSearch() {
  const s = containerEl?.querySelector('#rs-search');
  if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ------------------------------------------------------------
// "Match to a family"
// ------------------------------------------------------------
// The matched shelf was previously reachable only through the WhatsApp send
// button on the calling portal, which reads as a send action, so nobody used
// it to look something up. This is the same matching, reachable from the
// library itself, and it changes the URL so the view can be shared.
//
// RLS on public.patients decides what comes back. A mentor searching here
// can only find people she is already allowed to see.
function openPatientPicker() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="form-group"><label class="form-label">Who are you looking for?</label>
      <input class="input" id="pp-q" placeholder="Type a name" autocomplete="off" /></div>
    <div id="pp-results" style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto"></div>
    <div class="form-actions"><button class="btn btn-secondary" id="pp-cancel">Cancel</button></div>`;
  showModal({ title: 'Match the shelf to a family', content: el, size: 'md' });
  el.querySelector('#pp-cancel').addEventListener('click', () => closeModal());

  const out = el.querySelector('#pp-results');
  let t = null;
  el.querySelector('#pp-q').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (q.length < 2) { out.innerHTML = ''; return; }
    t = setTimeout(async () => {
      const { data, error } = await getSupabase().from('patients')
        .select('id, full_name, age, gender, state, treatment_city')
        .eq('is_active', true).ilike('full_name', `%${q}%`).limit(12);
      if (error) { out.innerHTML = `<div class="due-meta">${esc(error.message)}</div>`; return; }
      out.innerHTML = (data || []).length
        ? data.map(p => `<button class="btn btn-ghost" data-pid="${p.id}" style="justify-content:flex-start;text-align:left;padding:9px 12px">
            <span><strong>${esc(p.full_name || 'Unnamed')}</strong>
            <span style="color:var(--ink-3);font-size:11.5px"> &middot; ${[p.age != null ? p.age + 'y' : null, p.state, p.treatment_city].filter(Boolean).map(esc).join(' &middot; ')}</span></span>
          </button>`).join('')
        : `<div class="due-meta">Nobody by that name in the records you can see.</div>`;
      out.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => {
        closeModal();
        // The URL carries it, so the view can be shared and Back works. The
        // router re-enters renderResources, which does the loading; calling
        // load() here as well would fetch the same shelf twice.
        navigate(`resources/${S.aid || 'all'}/for/${b.dataset.pid}`);
      }));
    }, 250);
  });
}

// ------------------------------------------------------------
// "Somebody rang them"
// ------------------------------------------------------------
// resource_checks has zero rows across 617 resources, which is why
// availability is 'unknown' everywhere and three of the seven filters the
// 24/08 report asked for cannot exist. Four seconds of an intern's time,
// once, is the whole fix, so the form is four fields and nothing else.
function openCheckModal(row, onDone = null) {
  const fl = S.flags.get(row.resource_id);
  const heldNow = row.held || fl?.held_back || isHeld(row);
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="font:var(--t-sm);color:var(--ink-2);margin-bottom:var(--s4)">
      <strong>${esc(clean(row.title))}</strong>${row.contact_phone ? ` &middot; <span class="tnum">${esc(row.contact_phone)}</span>` : ''}
    </div>
    ${heldNow ? `<div class="rs-hold" style="margin-bottom:var(--s4);font:var(--t-xs);padding:8px 10px;border-radius:var(--r-sm);background:var(--danger-soft);border-left:3px solid var(--danger)">
      <b style="color:var(--danger)">Held back from WhatsApp.</b> ${esc(fl ? reportSummary(fl.open_reasons).join('; ') : 'A family could not get through.')}
      If they answer now, the hold lifts for every family. If a family was turned away for an age limit, an office visit or papers, a manager should add that with Edit so the matcher filters it.</div>` : ''}
    <div class="form-group"><label class="form-label">Did anyone answer?</label>
      <div class="chip-row" id="ck-ans">
        <button type="button" class="fchip on" data-ans="yes">Yes, we spoke to them</button>
        <button type="button" class="fchip" data-ans="no">No, nobody picked up</button>
      </div>
      <div class="due-meta" style="margin-top:6px">Three unanswered attempts and the row is marked "phone never answered" for everyone.</div>
    </div>
    <div id="ck-answered">
      <div class="form-group"><label class="form-label">Do they have room right now?</label>
        <div class="chip-row" id="ck-avail">
          ${[['open', 'Yes, they have space'], ['waitlist', 'Waiting list'], ['full', 'Full'], ['closed', 'Closed down'], ['unknown', "They wouldn't say"]]
            .map(([k, l], i) => `<button type="button" class="fchip${i === 4 ? ' on' : ''}" data-av="${k}">${l}</button>`).join('')}
        </div></div>
      <div class="form-group"><label class="form-checkbox">
        <input type="checkbox" id="ck-visit" ${row.tags?.includes('must_go_in_person') ? 'checked' : ''} />
        <span>They want the family to come to the office in person</span></label></div>
      <div class="form-group"><label class="form-label">What did they say about space?</label>
        <input class="input" id="ck-cap" placeholder="e.g., 12 beds, all taken, try Monday" /></div>
    </div>
    <div class="form-group"><label class="form-label">Anything else worth recording</label>
      <input class="input" id="ck-notes" placeholder="Optional" /></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="ck-cancel">Cancel</button>
      <button class="btn btn-primary" id="ck-save">${icon('check')}Record it</button>
    </div>`;
  showModal({ title: 'Somebody rang them', content: el, size: 'md' });

  let answered = true, avail = 'unknown';
  const answeredBox = el.querySelector('#ck-answered');
  el.querySelectorAll('#ck-ans .fchip').forEach(b => b.addEventListener('click', () => {
    el.querySelectorAll('#ck-ans .fchip').forEach(x => x.classList.toggle('on', x === b));
    answered = b.dataset.ans === 'yes';
    // Nobody picked up, so nothing they might have said can be recorded.
    // The RPC refuses it anyway; hiding it stops the argument.
    answeredBox.hidden = !answered;
  }));
  el.querySelectorAll('#ck-avail .fchip').forEach(b => b.addEventListener('click', () => {
    el.querySelectorAll('#ck-avail .fchip').forEach(x => x.classList.toggle('on', x === b));
    avail = b.dataset.av;
  }));
  el.querySelector('#ck-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#ck-save').addEventListener('click', async () => {
    const btn = el.querySelector('#ck-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    const cap = el.querySelector('#ck-cap').value.trim();
    const { error } = await getSupabase().rpc('log_resource_check', {
      p_resource: row.resource_id,
      p_answered: answered,
      p_method: 'phone',
      p_availability: answered ? avail : null,
      p_visit_required: answered ? el.querySelector('#ck-visit').checked : null,
      p_capacity_notes: answered && cap ? cap : null,
      p_notes: el.querySelector('#ck-notes').value.trim() || null,
    });
    if (error) {
      showToast('Could not record it: ' + error.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}Record it`;
      return;
    }
    closeModal();
    showToast(answered
      ? (heldNow ? 'Recorded. They answered, so the hold is lifted for every family.' : 'Recorded. Everyone sees this now.')
      : (heldNow ? 'Recorded as no answer. It stays held back.' : 'Recorded as no answer'), 'success');
    await (onDone ? onDone() : load());
  });
}

// ------------------------------------------------------------
// Add / edit (managers & admins)
// ------------------------------------------------------------
// `prefill` seeds a NEW entry, e.g. an organisation a family named from the
// old PDF: adding it under the same name carries the family's report onto it
// (sql/142 matches by name), so it arrives held back until someone rings it.
function openResourceModal(existing, prefill = null) {
  const me = getCurrentProfile();
  const r = existing || prefill || {};
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="form-row">
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Title <span class="req">*</span></label>
        <input class="input" id="rm-title" value="${attr(r.title)}" placeholder="e.g., Free dharamshala near XYZ Cancer Centre" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Category <span class="req">*</span></label>
        <select class="select" id="rm-cat">${RESOURCE_CATEGORIES.map(c => `<option value="${c.key}" ${r.category === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Verified on</label>
        <input class="input" type="date" id="rm-verified" value="${r.verified_on || new Date().toISOString().slice(0, 10)}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">State</label>
        <input class="input" id="rm-state" value="${attr(r.state)}" placeholder="e.g., Maharashtra (or All India)" /></div>
      <div class="form-group"><label class="form-label">City</label>
        <input class="input" id="rm-city" value="${attr(r.city)}" placeholder="e.g., Mumbai" /></div>
    </div>
    <div class="form-group"><label class="form-label">Summary</label>
      <textarea class="textarea" id="rm-summary" placeholder="One short paragraph a mentor can read out on a call…">${esc(r.summary || '')}</textarea></div>
    <div class="form-group"><label class="form-label">Who it's for</label>
      <input class="input" id="rm-elig" value="${attr(r.eligibility)}" placeholder="e.g., outstation patients below the poverty line" /></div>

    <div class="fsec" style="margin-top:var(--s5)"><span class="fsec-ico">${icon('users')}</span>
      <div><h4>Who gets turned away</h4>
      <div class="fsec-sub">The 24 August field report: NGOs decline adults because they only take children up to 15 or 18, and nobody knew until the family had already been sent. An age left blank means no limit and never hides the row.</div></div></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Youngest they take</label>
        <input class="input" id="rm-agemin" type="number" min="0" max="120" value="${r.age_min ?? ''}" placeholder="blank = no limit" /></div>
      <div class="form-group"><label class="form-label">Oldest they take</label>
        <input class="input" id="rm-agemax" type="number" min="0" max="120" value="${r.age_max ?? ''}" placeholder="blank = no limit" /></div>
    </div>
    <div class="form-group"><label class="form-checkbox">
      <input type="checkbox" id="rm-visit" ${r.physical_visit_required ? 'checked' : ''} />
      <span>The family has to go to their office in person</span></label></div>

    <div class="fsec" style="margin-top:var(--s5)"><span class="fsec-ico">${icon('arrowRight')}</span>
      <div><h4>The steps to actually get it</h4>
      <div class="fsec-sub">This is the part families cannot find on their own, and it is blank on all 617 entries. Write it the way you would say it on the phone. What you type here reaches the patient's WhatsApp message.</div></div></div>
    <div class="form-group"><label class="form-label">How to apply, step by step</label>
      <textarea class="textarea" id="rm-apply" rows="4" placeholder="1. Call the number and ask for the medical social worker.&#10;2. Take the referral letter from your treating hospital.&#10;3. They allot a room the same day if one is free…">${esc(r.how_to_apply || '')}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Papers to carry</label>
        <input class="input" id="rm-docs" value="${attr(r.documents_needed)}" placeholder="Aadhaar, ration card, referral letter…" />
        <div class="due-meta" style="margin-top:5px">Typed in plain words. The known ones become a filter automatically, so a family without a ration card stops being sent here.</div></div>
      <div class="form-group"><label class="form-label">Ask for (person or desk)</label>
        <input class="input" id="rm-who" value="${attr(r.who_to_ask)}" placeholder="e.g., the MSW desk, 2nd floor" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Contact phone</label>
        <input class="input" id="rm-phone" value="${attr(r.contact_phone)}" /></div>
      <div class="form-group"><label class="form-label">Link</label>
        <input class="input" id="rm-link" value="${attr(r.link)}" placeholder="https://…" /></div>
    </div>
    <div class="form-group"><label class="form-label">Address</label>
      <input class="input" id="rm-address" value="${attr(r.address)}" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">WhatsApp</label>
        <input class="input" id="rm-wa" value="${attr(r.whatsapp)}" placeholder="10-digit number" /></div>
      <div class="form-group"><label class="form-label">Email</label>
        <input class="input" id="rm-email" value="${attr(r.email)}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Cost to the family</label>
        <select class="select" id="rm-cost">
          ${[['free', 'Free'], ['subsidised', 'Subsidised / discounted'], ['paid', 'Paid'], ['unknown', 'Not known yet']]
            .map(([k, l]) => `<option value="${k}" ${(r.cost || 'unknown') === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Cheapest bed (₹ a night, 0 if free)</label>
        <input class="input" id="rm-amount" type="number" min="0" step="1" value="${r.amount_min_inr ?? ''}" />
        <div class="due-meta" style="margin-top:5px">0 puts it on the Free stays shelf. This is what the price filter reads.</div></div>
    </div>
    <div class="form-group"><label class="form-checkbox">
      <input type="checkbox" id="rm-public" ${r.is_public === false ? '' : 'checked'} />
      <span>Show on the public link families can open without signing in</span></label></div>

    <div class="form-actions">
      ${existing ? `<button class="btn btn-ghost" id="rm-retire" style="color:var(--danger);margin-right:auto">${icon('trash')}Retire</button>` : ''}
      <button class="btn btn-secondary" id="rm-cancel">Cancel</button>
      <button class="btn btn-primary" id="rm-save">${icon('check')}${existing ? 'Save changes' : 'Add to the shelf'}</button>
    </div>`;
  showModal({ title: existing ? 'Edit resource' : 'Add a resource', content: el, size: 'xl' });

  el.querySelector('#rm-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#rm-retire')?.addEventListener('click', async () => {
    try {
      await mustWrite(getSupabase().from('resources').update({ is_active: false }).eq('id', existing.id), 'resource');
      closeModal(); showToast('Retired from the shelf', 'info'); await load();
    } catch (e) { showToast('Could not retire: ' + e.message, 'error'); }
  });
  el.querySelector('#rm-save').addEventListener('click', async () => {
    const v = (id) => el.querySelector('#' + id)?.value.trim() || null;
    const title = v('rm-title');
    if (!title) { showToast('A title is required', 'warning'); return; }
    const btn = el.querySelector('#rm-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    const amount = el.querySelector('#rm-amount').value.trim();
    const patch = {
      title, category: v('rm-cat') || 'other', state: v('rm-state'), city: v('rm-city'),
      summary: v('rm-summary'), eligibility: v('rm-elig'), contact_phone: v('rm-phone'),
      link: v('rm-link'), address: v('rm-address'), verified_on: v('rm-verified'),
      // sql/121 keeps documents_needed and documents_required in step, and
      // who_to_ask and ask_for_name, so what a manager types here reaches
      // both the filter and the patient's message.
      how_to_apply: v('rm-apply'), documents_needed: v('rm-docs'), who_to_ask: v('rm-who'),
      age_min: intOrNull(el.querySelector('#rm-agemin').value),
      age_max: intOrNull(el.querySelector('#rm-agemax').value),
      physical_visit_required: el.querySelector('#rm-visit').checked,
      whatsapp: v('rm-wa'), email: v('rm-email'),
      cost: v('rm-cost') || 'unknown',
      amount_min_inr: amount === '' ? null : Number(amount),
      price_from: amount === '' ? null : Number(amount),
      is_public: el.querySelector('#rm-public').checked,
      is_sample: false,   // any human add/edit makes the entry real
    };
    try {
      const sb = getSupabase();
      if (existing) {
        await mustWrite(sb.from('resources').update(patch).eq('id', existing.id), 'resource');
      } else {
        const { error } = await sb.from('resources').insert({ ...patch, created_by: me.id, is_active: true });
        if (error) throw error;
      }
      closeModal();
      showToast(existing ? 'Resource updated' : 'Added. Mentors can see it now', 'success');
      await load();
    } catch (e) {
      showToast('Could not save: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}${existing ? 'Save changes' : 'Add to the shelf'}`;
    }
  });
}

// ------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = (s) => esc(s ?? '');
// sql/142 rewrote the dash characters sql/82 had left in organisation names
// and addresses, and a trigger keeps them out. This still covers any row
// written before that ran, and every dash-like character, not just two.
const clean = (s) => String(s ?? '').replace(/[\u2010-\u2015\u2212]/g, '-');
const shortDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
const numOrNull = (v) => { const n = Number(v); return (v === '' || v == null || !isFinite(n)) ? null : n; };
const intOrNull = (v) => { const n = parseInt(String(v).trim(), 10); return isFinite(n) ? n : null; };
