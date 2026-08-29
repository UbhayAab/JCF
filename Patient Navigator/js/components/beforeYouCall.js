// ============================================================
// "Before you call" - what has already been said about this patient.
//
// Two things live in this card, both of them things a mentor currently has to
// reconstruct by reading every note in the history:
//
//   A1  what the reader heard in the call notes, with the exact words
//   A5  the handover draft, when this patient was passed to somebody new
//
// A3 is deliberately NOT here. The Wellbeing tab already renders first score,
// last score and the direction of travel per instrument, coloured by whether
// that direction is good for that measure. Adding a second, slightly different
// account of the same numbers on the same record is how two screens end up
// disagreeing about a patient in front of the person calling her.
//
// NOTHING IN HERE IS A CONCLUSION
//
// Every signal shows the sentence a mentor typed, not a paraphrase, and the
// handover fields are a draft the receiving mentor edits and accepts. The card
// says who wrote what and when. If the reader is wrong, the quote beside it
// shows that immediately, which is the whole reason the quote is mandatory in
// the schema rather than encouraged in the prompt.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { showToast } from './toast.js';

const KIND = {
  red_flag:         { label: 'Red flag',  tone: 'danger',  rank: 0 },
  contradiction:    { label: 'Disagreed with the form', tone: 'warn', rank: 1 },
  caregiver_strain: { label: 'Caregiver', tone: 'warn',    rank: 2 },
  unmet_need:       { label: 'Asked for', tone: 'primary', rank: 3 },
  commitment:       { label: 'We promised', tone: 'neutral', rank: 4 },
  mindset:          { label: 'Sounded',  tone: 'neutral', rank: 5 },
};

const HANDOVER_FIELDS = [
  ['lead_with',   'Open with'],
  ['care_about',  'What matters to this family'],
  ['what_helped', 'What has worked'],
  ['best_time',   'When to call'],
];

const pretty = (s) => String(s || '').replace(/_/g, ' ');

// When the patient actually said it. Falls back to the row's own timestamp only
// when the call could not be joined, which is the honest worst case rather than
// a blank.
const saidOn = (s) => s.said_on || s.call_logs?.call_date || s.created_at;

export async function mountBeforeYouCall(mount, patient) {
  if (!mount) return;
  const sb = getSupabase();

  const [sigRes, hoRes] = await Promise.all([
    sb.from('call_signals')
      // created_at is when the READER ran, which after a backlog sweep is the
      // same afternoon for a note from two years ago. The date a mentor needs
      // is when the patient said it, and that only lives on the call.
      .select('kind, code, quote, confidence, created_at, call_log_id, call_logs(call_date)')
      .eq('patient_id', patient.id)
      .order('created_at', { ascending: false })
      .limit(40),
    sb.from('handover_drafts')
      .select('id, lead_with, care_about, what_helped, best_time, calls_read, created_at, accepted_at, accepted_by, from_user, to_user')
      .eq('patient_id', patient.id)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  // A table that has not been created yet, or one this role cannot read, is not
  // an error worth a red box on a patient record. It is simply nothing to show.
  // A query that DID work and returned nothing is also nothing to show. Both
  // collapse to the same empty card, and the console carries the difference.
  if (sigRes.error) console.warn('call_signals unavailable:', sigRes.error.message);
  if (hoRes.error) console.warn('handover_drafts unavailable:', hoRes.error.message);

  const signals = dedupe(sigRes.data || []);
  const draft = (hoRes.data || [])[0] || null;
  if (!signals.length && !draft) { mount.innerHTML = ''; return; }

  mount.innerHTML = `
    <div class="card byc" style="margin-bottom:var(--s5)">
      <div class="card-header">
        <div>
          <div class="card-title">Before you call</div>
          <div class="card-subtitle">Read out of the call notes. Every line shows the words it came from.</div>
        </div>
      </div>
      ${draft ? handoverHtml(draft) : ''}
      ${signals.length ? `<div class="byc-sigs">
        ${signals.map(sigRow).join('')}
      </div>` : ''}
    </div>`;

  const accept = mount.querySelector('#byc-accept');
  if (accept) accept.addEventListener('click', () => acceptDraft(sb, draft, mount, patient));
}

// The same sentence is honestly several things at once often enough that
// rendering it three times is the common case, not the edge case. See the
// measured note on dedupe() in js/pages/brief.js.
export function dedupe(rows) {
  const byQuote = new Map();
  const out = [];
  for (const s of [...rows].sort((a, b) => (KIND[a.kind]?.rank ?? 9) - (KIND[b.kind]?.rank ?? 9))) {
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

export function sigRow(s) {
  const badges = [s.kind, ...s.also].map((k) => {
    const m = KIND[k] || { label: pretty(k), tone: 'neutral' };
    return `<span class="badge badge-${m.tone === 'primary' ? 'primary' : m.tone}">${m.label}</span>`;
  }).join('');
  return `
    <div class="byc-sig">
      <div class="byc-sig-head">
        ${badges}
        <span>${sanitize(pretty(s.code))}</span>
        ${s.confidence === 'low' ? '<span class="badge badge-neutral">not sure</span>' : ''}
        <span class="byc-when">${saidOn(s) ? formatRelativeTime(saidOn(s)) : ''}</span>
      </div>
      ${s.quote ? `<div class="byc-quote">&ldquo;${sanitize(s.quote)}&rdquo;</div>` : ''}
    </div>`;
}

export function handoverHtml(d) {
  const filled = HANDOVER_FIELDS.filter(([k]) => d[k]);
  // best_time came back null on the first live run because the notes did not
  // say. That is the no-invention rule working, and an empty field is shown as
  // empty rather than dropped: "we do not know when she picks up" is itself
  // worth knowing before you dial at 9am.
  const blank = HANDOVER_FIELDS.filter(([k]) => !d[k]).map(([, l]) => l);
  return `
    <div class="byc-handover">
      <div class="byc-sig-head">
        <span class="badge badge-primary">Handover</span>
        <span>drafted from ${d.calls_read} call${d.calls_read === 1 ? '' : 's'}</span>
        <span class="byc-when">${d.created_at ? formatRelativeTime(d.created_at) : ''}</span>
        ${d.accepted_at
          ? `<span class="badge badge-ok">accepted ${formatRelativeTime(d.accepted_at)}</span>`
          : '<span class="badge badge-warn">not read yet</span>'}
      </div>
      ${filled.map(([k, label]) => `
        <div class="byc-ho-field">
          <div class="byc-ho-label">${label}</div>
          <div class="byc-ho-value">${sanitize(d[k])}</div>
        </div>`).join('')}
      ${blank.length ? `<div class="byc-ho-blank">
        The notes did not say: ${blank.join(', ').toLowerCase()}.</div>` : ''}
      ${d.accepted_at ? '' : `
        <button class="btn btn-secondary btn-sm" id="byc-accept" style="margin-top:10px"
          >${icon('check')}I have read this</button>`}
    </div>`;
}

async function acceptDraft(sb, draft, mount, patient) {
  const me = getCurrentProfile();
  const { error } = await sb.from('handover_drafts')
    .update({ accepted_by: me?.id || null, accepted_at: new Date().toISOString() })
    .eq('id', draft.id);
  if (error) { showToast(error.message, 'error'); return; }
  showToast('Marked as read', 'success');
  await mountBeforeYouCall(mount, patient);
}
