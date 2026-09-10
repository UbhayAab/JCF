// ============================================================
// Patient Navigator: the morning brief
//
// A mentor opens the portal with forty patients and ten minutes. Today she
// gets a queue: a list of names in an order nobody can see the reason for.
// This page is the reason, one line per person, before she dials.
//
// WHY THERE IS NO MODEL ON THIS PAGE
//
// Every line here was going to be a sentence written by Gemini. It is not,
// because every input to that sentence is ALREADY a row carrying its own
// evidence:
//
//   the priority ladder    a `reason` string sql/80 generates
//   an open concern        its reason, and how many days it has been open
//   a call signal          a verbatim quote from a note a mentor typed
//   a wellbeing change     two numbers and the days between them
//
// Paraphrasing those would cost money, add latency, add a way to be wrong,
// and replace a quote she can check with a sentence she cannot. The only AI
// on this page is A1's signals, read once when the note was written and
// re-used here rather than regenerated.
//
// mentor_brief() is SECURITY INVOKER, so a mentor sees her own queue and a
// manager sees the team's. That is the whole access control.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { icon } from '../components/icons.js';
import { navigate } from '../router.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { concernReason } from '../utils/catalog.js';

const BAND_TONE = { urgent: 'danger', high: 'warn', watch: 'info', steady: 'neutral' };

// The signal kinds worth a mentor's eye before a call, in the order she should
// meet them. `mindset` and `commitment` are deliberately quieter: knowing the
// family sounded hopeful does not change what she does in the next ten
// minutes, and a wall of equal-weight badges is a wall nobody reads.
const SIGNAL_LABEL = {
  red_flag: { label: 'Red flag', tone: 'danger', rank: 0 },
  contradiction: { label: 'The note disagreed with the form', tone: 'warn', rank: 1 },
  caregiver_strain: { label: 'Caregiver', tone: 'warn', rank: 2 },
  unmet_need: { label: 'Asked for', tone: 'info', rank: 3 },
  commitment: { label: 'We promised', tone: 'neutral', rank: 4 },
  mindset: { label: 'Sounded', tone: 'neutral', rank: 5 },
};

const MEASURE_LABEL = {
  phq4_patient: 'Patient mood (PHQ-4)', phq4_caregiver: 'Caregiver mood (PHQ-4)',
  zarit_burden: 'Caregiver burden', financial_toxicity: 'Money strain',
  must_malnutrition: 'Malnutrition risk', qol_physical: 'Physical wellbeing',
  qol_emotional: 'Emotional wellbeing', activation: 'Confidence to self-manage',
  caregiver_confidence: 'Caregiver confidence', grief_screen: 'Grief',
};

const pretty = (s) => String(s || '').replace(/_/g, ' ');

// Who a note came from. A mentor treats "the ground team met this family in
// person" differently from "a mentor wrote this after a call", so the source
// is the first thing on the line, not a footnote.
const GROUND_SOURCE = {
  ground_poc: 'Ground team',
  uploader: 'Intake',
  system: 'Automatic',
  caregiver_mentor: 'A mentor',
  caller: 'A mentor',
  nutritionist: 'Nutrition',
  manager: 'A supervisor',
  admin: 'A supervisor',
};

// A quote with no date beside it reads as something the family said this week.
// Inside a fortnight that is true and the date is noise; past it the mentor has
// to be told, or she opens a call by responding to a worry the family may have
// moved on from a month ago.
const FRESH_DAYS = 14;
function staleness(saidOn) {
  if (!saidOn) return '';
  const days = (Date.now() - new Date(saidOn).getTime()) / 864e5;
  if (!(days > FRESH_DAYS)) return '';
  return `<span class="brief-when">${sanitize(formatRelativeTime(saidOn))}</span>`;
}

export async function renderBrief(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>This morning</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Everyone on your list, and why.
          Nothing here is a guess: each line points at the thing that put them on it.</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="br-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div id="br-body"><div class="card"><div class="spinner"></div></div></div>`;

  container.querySelector('#br-refresh').addEventListener('click', () => load(container));
  await load(container);
}

async function load(container) {
  const body = container.querySelector('#br-body');
  const sb = getSupabase();
  const me = getCurrentProfile();

  // mentor_brief(), not the view it is built from. The view returns the same
  // rows and took 9.4 seconds for the worst mentor measured, which is past
  // Supabase's 8 s cancel, so the page 500'd and told her nobody was waiting.
  // A function takes the mentor as a parameter at plan time and the queue
  // narrows before the expensive priority view is computed. sql/110 carries
  // the numbers.
  //
  // A manager passes null and gets the team; a mentor passes her own id. RLS
  // decides either way, so this is about not showing a manager one row when
  // she wanted twenty.
  const { data, error } = await sb.rpc('mentor_brief', {
    p_mentor: isManagerOrAdmin() ? null : (me?.id ?? null),
  });

  // An error and an empty list are the same picture unless this is checked,
  // and "no patients today" is a sentence a mentor acts on by going home.
  // sql/73 made exactly this mistake with call_logs and it made every later
  // "the data is missing" report unanswerable.
  if (error) {
    body.innerHTML = `<div class="card"><div class="empty">
      <div class="ico-wrap">${icon('alertCircle')}</div>
      <h4>We could not load your list</h4>
      <p>${sanitize(error.message)}</p>
      <p class="form-hint">This is not the same as having nobody to call today.</p>
    </div></div>`;
    return;
  }

  const rows = data || [];

  // The ground team's notes (sql/125), asked for on 08/09: the CGMP team must
  // be able to "review the notes before contacting the patient". This page IS
  // before, so the notes belong on it.
  //
  // One batched read for the whole queue rather than one per card, through
  // plain patient_notes RLS (can_open_patient_record) rather than the per-call
  // RPC, because here she holds the queue for all of them and 30 round trips
  // to save one join is how this page got slow the first time. A failure is
  // swallowed on purpose: a missing note must never take the call list down,
  // and it is logged so a real outage is still findable.
  const notesBy = new Map();
  if (rows.length) {
    try {
      const { data: notes, error: nErr } = await sb
        .from('patient_notes')
        .select('patient_id, body, author_role, pinned, created_at, profiles:author_id(full_name)')
        .in('patient_id', rows.map(r => r.patient_id))
        .is('deleted_at', null)
        .order('pinned', { ascending: false })
        .order('created_at', { ascending: false });
      if (nErr) throw nErr;
      for (const n of notes || []) {
        const list = notesBy.get(n.patient_id) || [];
        if (list.length < 2) list.push(n);           // two lines per card, no more
        notesBy.set(n.patient_id, list);
      }
    } catch (e) { console.warn('Ground notes unavailable:', e.message); }
  }
  for (const r of rows) r.ground_notes = notesBy.get(r.patient_id) || [];

  if (!rows.length) {
    body.innerHTML = `<div class="card"><div class="empty">
      <div class="ico-wrap">${icon('checkCircle')}</div>
      <h4>Nobody is waiting</h4>
      <p>Your queue is empty. It fills again at noon.</p>
    </div></div>`;
    return;
  }

  // Urgent first, then anything the reader flagged, then the ladder's own
  // order. A patient with an open urgent concern and a red flag in her last
  // note should not be below someone who is merely overdue.
  const weight = (r) => {
    const sig = r.signals || [];
    return (r.priority_band === 'urgent' ? 0 : r.priority_band === 'high' ? 100 : 300)
         - (r.open_concern ? 40 : 0)
         - (sig.some((s) => s.kind === 'red_flag') ? 30 : 0)
         - (sig.some((s) => s.kind === 'contradiction') ? 20 : 0)
         - ((r.worsened || []).length ? 10 : 0);
  };
  rows.sort((a, b) => weight(a) - weight(b));

  const needsEye = rows.filter((r) => r.open_concern
    || (r.signals || []).some((s) => s.kind === 'red_flag' || s.kind === 'contradiction')
    || (r.worsened || []).length);
  const withNotes = rows.filter((r) => (r.ground_notes || []).length).length;

  body.innerHTML = `
    <div class="doc-callout" style="margin-bottom:var(--s3)">
      <strong>${icon('info')} ${rows.length} to call${needsEye.length
        ? `, and ${needsEye.length} of them need a look first` : ''}.</strong>
      <p>Ordered by who needs you most. Quotes are a mentor's own words, from calls in the last 60 days.${
        withNotes ? ` ${withNotes} of them carry a note from the ground team: read it before you dial.` : ''}</p>
    </div>
    <div class="brief-list">${rows.map(card).join('')}</div>`;

  body.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => navigate(`patients/${b.dataset.open}`)));
}

// One sentence in a note is often honestly several things at once: "I have
// sent him the updated financial help lists" is a request and a promise, and
// the reader files it as both. Rendered naively that is the same sentence
// printed two or three times, and on the most loaded card it eats the four
// visible slots with one thought.
//
// MEASURED on the 10 real signal-carrying patients, 2026-08-29: 4 of 30 signal
// rows (13%) repeat a quote already on the same card, and 3 of the 10 cards
// (30%) show at least one repeat. Highest-ranked kind wins the row and the
// other kinds ride along as extra badges, so nothing is lost and the slot is
// given back.
function dedupe(signals) {
  const byQuote = new Map();
  const out = [];
  for (const s of [...signals].sort(
    (a, b) => (SIGNAL_LABEL[a.kind]?.rank ?? 9) - (SIGNAL_LABEL[b.kind]?.rank ?? 9))) {
    const key = (s.quote || '').trim().toLowerCase();
    if (!key) { out.push({ ...s, also: [] }); continue; }
    const first = byQuote.get(key);
    if (first) { if (first.kind !== s.kind) first.also.push(s.kind); continue; }
    const row = { ...s, also: [] };
    byQuote.set(key, row);
    out.push(row);
  }
  return out;
}

export function card(r) {
  const sig = dedupe(r.signals || []);
  const shown = sig.slice(0, 4);
  const worsened = (r.worsened || []).slice(0, 3);
  const bandClass = { urgent: 'is-urgent', high: 'is-high', watch: 'is-watch' }[r.priority_band] || '';

  return `
    <div class="card brief-card ${bandClass}">
      <div class="brief-top">
        <div class="brief-main">
          <div class="brief-name">
            <button class="btn btn-ghost btn-sm" data-open="${r.patient_id}"
              >${sanitize(r.patient_name || 'Unnamed')}</button>
            ${r.priority_band ? `<span class="badge badge-${BAND_TONE[r.priority_band] === 'danger' ? 'danger'
              : BAND_TONE[r.priority_band] === 'warn' ? 'warn' : 'neutral'}"
              >${sanitize(r.priority_band)}</span>` : ''}
            ${r.source === 'concern'
              ? '<span class="badge badge-danger">Flag brought this forward</span>' : ''}
            ${r.patient_code ? `<span class="hist-meta">${sanitize(r.patient_code)}</span>` : ''}
          </div>

          ${r.priority_reason
            ? `<div class="brief-line">${icon('info')}<span>${sanitize(r.priority_reason)}</span></div>` : ''}

          ${(r.ground_notes || []).length ? `<div class="brief-sigs">
            ${r.ground_notes.map((n) => `<div class="brief-sig">
              <span class="badge badge-gold">${sanitize(GROUND_SOURCE[n.author_role] || 'Team note')}</span>
              ${n.pinned ? '<span class="badge badge-danger">Read first</span>' : ''}
              <span class="brief-quote">${sanitize(String(n.body).slice(0, 240))}${
                String(n.body).length > 240 ? '&hellip;' : ''}</span>
              <span class="brief-when">${sanitize(n.profiles?.full_name || '')}${
                n.profiles?.full_name ? ' · ' : ''}${sanitize(formatRelativeTime(n.created_at))}</span>
            </div>`).join('')}
          </div>` : ''}

          ${r.open_concern ? `<div class="brief-line">
            <span class="badge badge-${r.concern_severity === 'urgent' ? 'danger'
              : r.concern_severity === 'high' ? 'warn' : 'neutral'}"
              >${sanitize(concernReason(r.open_concern).label || pretty(r.open_concern))}</span>
            <span>${r.concern_days_open == null ? 'still open'
              : `open ${r.concern_days_open} day${r.concern_days_open === 1 ? '' : 's'}`}</span>
          </div>` : ''}

          ${shown.length ? `<div class="brief-sigs">
            ${shown.map((s) => `<div class="brief-sig">
                ${[s.kind, ...s.also].map((k) => {
                  const km = SIGNAL_LABEL[k] || { label: pretty(k), tone: 'neutral' };
                  return `<span class="badge badge-${km.tone === 'danger' ? 'danger'
                    : km.tone === 'warn' ? 'warn' : km.tone === 'info' ? 'primary' : 'neutral'}"
                    >${km.label}</span>`;
                }).join('')}
                <span>${sanitize(pretty(s.code))}</span>
                ${s.quote ? `<span class="brief-quote">&ldquo;${sanitize(s.quote)}&rdquo;</span>` : ''}
                ${staleness(s.said_on)}
              </div>`).join('')}
            ${sig.length > shown.length
              ? `<span class="brief-more">and ${sig.length - shown.length} more on this record</span>` : ''}
          </div>` : ''}

          ${worsened.length ? `<div class="brief-worse">
            ${worsened.map((w) => `<div class="brief-line" style="margin-top:0">${icon('activity')}
              <span>${sanitize(MEASURE_LABEL[w.measure] || pretty(w.measure))}
                went ${w.from} to ${w.to} over ${w.days} days</span></div>`).join('')}
          </div>` : ''}
        </div>
        <button class="btn btn-secondary btn-sm" data-open="${r.patient_id}">Open record</button>
      </div>
    </div>`;
}
