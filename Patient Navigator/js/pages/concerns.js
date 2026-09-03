// ============================================================
// Patient Navigator: Concerns (clinical escalation queue)
// Where red flags land. Auto-flags come from assessment scores
// and critical calls (sql/43 triggers); manual flags come from
// the "Raise a concern" button in the Calling Portal.
// Managers/admins triage; everyone else sees the flags they raised.
// ============================================================

import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { concernReason } from '../utils/catalog.js';

const SEV_RANK = { urgent: 0, high: 1, watch: 2 };
const SEV_COLOR = { urgent: 'var(--danger)', high: 'var(--clay)', watch: 'var(--info)' };

let rows = [];
let containerEl = null;
let sevFilter = null; // 'urgent' | 'high' | 'watch' | null: set by tapping a stat card
let searchQ = '';     // the raw box contents, lowercased
let searchTerms = null; // parsed form of searchQ: see parseQuery()
let loadSeq = 0;      // only the newest load() may write to the page
let inFlight = null;
const LOAD_TIMEOUT_MS = 20000;

export async function renderConcerns(container) {
  containerEl = container;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Concerns</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${isManagerOrAdmin()
          ? 'Red flags from calls and assessments. Urgent means today. No flag waits alone.'
          : 'Flags you raised, and what happened to them. Raising one is doing your job perfectly.'}</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="cq-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s2)">
      <div class="table-search" style="max-width:420px;flex:1 1 260px">
        ${icon('search')}
        <input class="form-input" id="cq-search" type="search" autocomplete="off"
          placeholder="Name, phone, patient ID, city, hospital, reason…" aria-label="Search concerns" />
      </div>
      <button class="btn btn-ghost btn-sm" id="cq-clear-search" style="display:none">${icon('x')}Clear</button>
    </div>
    <div id="cq-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading concerns…</div></div>`;
  container.querySelector('#cq-refresh')?.addEventListener('click', load);

  // Typing filters what is already loaded, so it is instant and needs no
  // debounce. Searching also drops any severity filter: hunting for one
  // patient must not be silently narrowed to "urgent only".
  const box = container.querySelector('#cq-search');
  const clearBtn = container.querySelector('#cq-clear-search');
  box?.addEventListener('input', () => {
    searchQ = box.value.trim().toLowerCase();
    searchTerms = parseQuery(searchQ);
    if (searchQ) sevFilter = null;
    if (clearBtn) clearBtn.style.display = searchQ ? '' : 'none';
    paint();
  });
  clearBtn?.addEventListener('click', () => {
    if (box) box.value = '';
    searchQ = '';
    searchTerms = null;
    clearBtn.style.display = 'none';
    box?.focus();
    paint();
  });
  await load();
}

async function load() {
  const sb = getSupabase();
  const body = containerEl?.querySelector('#cq-body');
  if (!body) return;
  const cols = `*,
        patient:patients(id, full_name, patient_code, city, state,
          treating_hospital, cancer_type, gi_subtype, caregiver_name,
          phone_full, caregiver_phone_full,
          patient_phones(phone, label, contact_name, priority)),
        raiser:profiles!patient_concerns_raised_by_fkey(full_name),
        resolver:profiles!patient_concerns_resolved_by_fkey(full_name),
        acknowledger:profiles!patient_concerns_acknowledged_by_fkey(full_name)`;
  // A request that never comes back used to leave this page on "Loading
  // concerns…" with no way out but a browser refresh, which is the same
  // complaint the Patients list got. Cap the wait and offer a Retry instead.
  loadSeq += 1;
  const seq = loadSeq;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const giveUp = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

  try {
    // Two reads, not one capped list. The old single `.limit(300)` ordered by
    // newest meant that once enough flags had been resolved, older OPEN ones
    // fell off the end, and a search for that patient would come back empty
    // while the concern was still sitting there unhandled. Open work is never
    // truncated. The resolved ledger is, because it is history.
    const [openRes, doneRes] = await Promise.all([
      sb.from('patient_concerns').select(cols)
        .in('status', ['open', 'acknowledged'])
        .order('created_at', { ascending: false })
        .abortSignal(controller.signal),
      sb.from('patient_concerns').select(cols)
        .eq('status', 'resolved')
        .order('resolved_at', { ascending: false, nullsFirst: false })
        .limit(200)
        .abortSignal(controller.signal),
    ]);
    if (seq !== loadSeq) return;             // a newer load owns the page
    if (openRes.error) throw openRes.error;
    if (doneRes.error) throw doneRes.error;

    // v108: what the reader made of each open flag. A separate query rather
    // than a join, because a project that has not run sql/108 yet still has a
    // working concerns page; an error here degrades to no badges, never to a
    // blank list.
    const revRes = await sb.from('concern_reviews')
      .select('concern_id, verdict, quote, calls_since, days_open')
      .abortSignal(controller.signal);
    if (revRes.error) console.warn('concern reviews unavailable:', revRes.error.message);
    const byConcern = {};
    for (const v of (revRes.data || [])) byConcern[v.concern_id] = v;

    rows = [...(openRes.data || []), ...(doneRes.data || [])]
      .map((r) => ({ ...r, review: byConcern[r.id] || null }))
      .map(indexRow);
    paint();
  } catch (e) {
    if (seq !== loadSeq) return;
    const slow = controller.signal.aborted || /abort/i.test(e.message || '');
    body.innerHTML = `
      <div class="empty">
        <div class="ico-wrap">${icon('alertCircle')}</div>
        <h4>Could not load concerns</h4>
        <p>${slow ? 'The list took too long to come back.' : sanitizeText(e.message || 'Something went wrong.')}</p>
        <button class="btn btn-secondary btn-sm" id="cq-retry">Retry</button>
      </div>`;
    body.querySelector('#cq-retry')?.addEventListener('click', () => {
      body.innerHTML = `<div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading concerns…</div>`;
      load();
    });
  } finally {
    clearTimeout(giveUp);
  }
}

function paint() {
  const body = containerEl?.querySelector('#cq-body');
  if (!body) return;
  const visible = rows.filter(matchesSearch);
  const open = visible.filter(r => r.status === 'open' || r.status === 'acknowledged')
    .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (new Date(a.created_at) - new Date(b.created_at)));
  const resolved = visible.filter(r => r.status === 'resolved');
  const groups = {
    urgent: open.filter(r => r.severity === 'urgent'),
    high: open.filter(r => r.severity === 'high'),
    watch: open.filter(r => r.severity === 'watch'),
  };

  // one severity group, rendered as a titled ledger section. Watch collapses
  // when long. The wall of 60 cards is what made this page unreadable.
  const groupHTML = (key, title, hint) => {
    const list = groups[key];
    if (!list.length || (sevFilter && sevFilter !== key)) return '';
    const cards = `<div style="display:flex;flex-direction:column;gap:10px">${groupByPatient(list)}</div>`;
    const head = `
      <div style="display:flex;align-items:baseline;gap:10px;margin:0 0 10px">
        <span class="lever-group-title" style="margin:0;color:${SEV_COLOR[key]}">${title} · ${list.length}</span>
        <span class="hist-meta">${hint}</span>
      </div>`;
    if (key === 'watch' && list.length > 6 && !sevFilter && !searchQ) {
      return `
      <details class="card" style="padding:14px 16px;margin-top:var(--s5)">
        <summary style="cursor:pointer;font:var(--t-body-strong);display:flex;align-items:center;gap:8px">
          <span style="width:17px;height:17px;display:inline-flex;color:var(--info)">${icon('search')}</span>
          Watching · ${list.length} <span class="hist-meta" style="font-weight:400">(no action due yet; open to review)</span>
        </summary>
        <div style="margin-top:12px">${cards}</div>
      </details>`;
    }
    return `<section style="margin-top:var(--s5)">${head}${cards}</section>`;
  };

  body.innerHTML = `
    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s4);margin-bottom:var(--s2)">
      ${statCard('Urgent: act today', groups.urgent.length, groups.urgent.length > 0 ? 'danger' : 'ok', 'alertTriangle', 'urgent')}
      ${statCard('High: this week', groups.high.length, groups.high.length > 0 ? 'warn' : 'ok', 'alertCircle', 'high')}
      ${statCard('Watching', groups.watch.length, 'info', 'search', 'watch')}
      ${statCard('Resolved (recent)', resolved.length, 'ok', 'checkCircle')}
    </div>
    ${sevFilter ? `<div style="margin-bottom:var(--s2)"><button class="btn btn-ghost btn-sm" id="cq-clear-filter">${icon('x')}Clear ${sevFilter} filter</button></div>` : ''}
    ${searchQ ? `<div class="hist-meta" style="margin-bottom:var(--s2)">${visible.length} of ${rows.length} flags match “${sanitizeText(searchQ)}” · ${open.length} still open, ${resolved.length} already resolved</div>` : ''}

    ${open.length === 0 ? (searchQ ? `
      <div class="empty" style="padding:36px 20px">
        <div class="ico-wrap">${icon('search')}</div>
        <h4>No open concern matches that</h4>
        <p>${resolved.length
          ? 'Every match below has already been resolved.'
          : 'Nothing on this page matches. Check the spelling, or try the patient ID.'}</p>
      </div>` : `
      <div class="empty" style="padding:44px 20px">
        <div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div>
        <h4>No open concerns</h4><p>Every flag has been seen and handled. That's the whole point.</p>
      </div>`) : `
      ${groupHTML('urgent', 'Urgent: act today', 'call the family or the treating team before anything else')}
      ${groupHTML('high', 'High: this week', 'needs a plan in the next few days')}
      ${groupHTML('watch', 'Watching', 'keep an eye; next call covers it')}`}

    ${resolved.length ? `
      <details class="card" style="margin-top:var(--s5);padding:16px 18px" ${searchQ ? 'open' : ''}>
        <summary style="cursor:pointer;font:var(--t-body-strong);display:flex;align-items:center;gap:8px">
          <span style="width:17px;height:17px;display:inline-flex;color:var(--ok)">${icon('checkCircle')}</span>
          Resolved · ${resolved.length}
        </summary>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
          ${(searchQ ? resolved : resolved.slice(0, 40)).map(r => `
            <div style="border-left:3px solid var(--ok);padding:8px 12px;background:var(--surface-2);border-radius:var(--r-sm)">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <strong style="font-size:13.5px">${patientName(r)}</strong>
                <span class="badge badge-neutral">${concernReason(r.reason).label}</span>
                <span class="hist-meta">resolved by ${r.resolver?.full_name || 'N/A'} · ${formatRelativeTime(r.resolved_at)}</span>
              </div>
              ${r.resolution_note ? `<div style="font:var(--t-xs);color:var(--ink-2);margin-top:4px">${r.resolution_note}</div>` : ''}
            </div>`).join('')}
        </div>
      </details>` : ''}`;

  body.querySelectorAll('[data-reassign]').forEach(b => b.addEventListener('click', () => openReassignModal(b.dataset.reassign)));
  body.querySelectorAll('[data-decline-reassign]').forEach(b => b.addEventListener('click', () => openDeclineReassignModal(b.dataset.declineReassign)));
  body.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => acknowledge(b.dataset.ack)));
  body.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', () => openResolveModal(b.dataset.resolve)));
  body.querySelectorAll('[data-open-patient]').forEach(b => b.addEventListener('click', () => { window.location.hash = 'patients/' + b.dataset.openPatient; }));
  body.querySelectorAll('[data-sev-filter]').forEach(c => c.addEventListener('click', () => {
    sevFilter = sevFilter === c.dataset.sevFilter ? null : c.dataset.sevFilter;
    paint();
  }));
  body.querySelector('#cq-clear-filter')?.addEventListener('click', () => { sevFilter = null; paint(); });
}

// ---- Holistic search -------------------------------------------------
// Everything about a flag that a person might type, flattened once when the
// rows land rather than rebuilt on every keystroke. Two forms are kept: the
// words, and a digits-only copy for phone and ID hunting.
//
// The digits copy joins each field SEPARATELY. Concatenating the whole row
// first would let the tail of a patient code run into the head of a phone
// number and invent matches that are not in any single field.
function rowFields(r) {
  const p = r.patient || {};
  const phones = (p.patient_phones || []).flatMap(x => [x.phone, x.contact_name, x.label]);
  return [
    p.full_name, p.patient_code, p.city, p.state, p.treating_hospital,
    p.cancer_type, p.gi_subtype, p.caregiver_name,
    p.phone_full, p.caregiver_phone_full, ...phones,
    concernReason(r.reason).label, r.reason, r.severity, r.status,
    r.note, r.resolution_note,
    r.raiser?.full_name, r.resolver?.full_name, r.acknowledger?.full_name,
  ].filter(Boolean).map(String);
}

function indexRow(r) {
  const f = rowFields(r);
  r._hay = f.join(' ').toLowerCase();
  r._digits = f.map(x => x.replace(/\D+/g, '')).filter(Boolean).join(' ');
  return r;
}

// A token made only of digits and phone punctuation is a number, not a word.
// Those tokens are glued back together before matching, so "98765 43210",
// "+91 98765 43210" and "9876543210" are one and the same search. Everything
// else stays a word, and every word must match: "vishal mumbai" narrows.
function parseQuery(q) {
  if (!q) return null;
  const words = [], numeric = [];
  for (const t of q.split(/\s+/).filter(Boolean)) {
    if (/^[+()\-.\d]+$/.test(t) && (t.match(/\d/g) || []).length >= 2) numeric.push(t);
    else words.push(t);
  }
  const d = numeric.join('').replace(/\D+/g, '');
  // A country code or a trunk 0 typed in front of a number we store bare would
  // otherwise miss, so anything longer than ten digits also tries its tail.
  const digits = d ? (d.length > 10 ? [d, d.slice(-10)] : [d]) : [];
  return (words.length || digits.length) ? { words, digits } : null;
}

function matchesSearch(r) {
  if (!searchTerms) return true;
  const { words, digits } = searchTerms;
  if (!words.every(w => r._hay.includes(w))) return false;
  if (digits.length && !digits.some(d => r._digits.includes(d))) return false;
  return true;
}

// The number to put on the card: normally the first one we hold for this
// family, in the same dial order the calling portal uses. But when the search
// WAS a number, show the number that matched - otherwise you type a
// caregiver's mobile, get back a card showing the patient's landline, and
// cannot tell whether the right family came up.
function primaryPhone(r) {
  const p = r.patient || {};
  const listed = [...(p.patient_phones || [])]
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
    .map(x => x.phone);
  const all = [p.phone_full, ...listed, p.caregiver_phone_full].filter(Boolean);
  const wanted = searchTerms?.digits || [];
  if (wanted.length) {
    const hit = all.find(ph => {
      const d = String(ph).replace(/\D+/g, '');
      return wanted.some(w => d.includes(w));
    });
    if (hit) return hit;
  }
  return all[0] || '';
}

// The search term is typed by a user and goes back into innerHTML.
// ---- v108: what the reader made of this flag ------------------------------
//
// Four verdicts, and only two of them are worth a mentor's eye. `still_open`
// is the one that matters: calls HAVE happened and none of them touched this,
// which is a different and worse thing than nobody having rung at all.
//
// `looks_handled` always shows its quote. It is the only verdict that could
// lead to a flag being closed, so the words from the later call that justify
// it are shown beside it and the mentor decides. She is not told to close it,
// and nothing closes itself.
const VERDICT = {
  still_open: {
    label: 'Not addressed yet', tone: 'warn',
    line: (v) => `${v.calls_since} call${v.calls_since === 1 ? '' : 's'} since this was raised`
               + `, and none of them touched it`,
  },
  nothing_since: {
    label: 'Nobody has called', tone: 'danger',
    line: () => 'No call at all since this was raised',
  },
  looks_handled: {
    label: 'Looks handled', tone: 'ok',
    line: (v) => `A later call suggests this was dealt with. You decide`,
  },
  cannot_tell: {
    label: 'Cannot tell', tone: 'plain',
    line: (v) => `${v.calls_since} call${v.calls_since === 1 ? '' : 's'} since, too thin to say either way`,
  },
};

export function reviewLine(r) {
  const v = r.review;
  if (!v || r.status === 'resolved') return '';
  const meta = VERDICT[v.verdict];
  if (!meta) return '';                     // an unknown verdict shows nothing
  const days = Number.isFinite(v.days_open)
    ? ` · ${v.days_open} day${v.days_open === 1 ? '' : 's'} open` : '';
  return `
    <div class="verdict is-${meta.tone}">
      <div class="verdict-head">
        <span class="badge badge-${meta.tone === 'ok' ? 'ok' : meta.tone === 'danger' ? 'danger'
          : meta.tone === 'warn' ? 'warn' : 'neutral'}">${meta.label}</span>
        <span>${sanitizeText(meta.line(v))}${days}</span>
      </div>
      ${v.quote ? `<div class="verdict-quote">&ldquo;${sanitizeText(v.quote)}&rdquo;</div>` : ''}
    </div>`;
}

function sanitizeText(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statCard(label, n, tone, ico, filterKey) {
  const active = filterKey && sevFilter === filterKey;
  return `
    <div class="card" ${filterKey ? `data-sev-filter="${filterKey}" role="button" tabindex="0"` : ''}
      style="padding:14px 16px;display:flex;align-items:center;gap:12px;${filterKey ? 'cursor:pointer;' : ''}${active ? 'box-shadow:var(--ring);' : ''}">
      <span class="stat-ico ${tone}">${icon(ico)}</span>
      <div><div style="font:var(--t-h3);line-height:1.1">${n}</div><div class="due-meta">${label}</div></div>
    </div>`;
}

function patientName(r) {
  // RLS can hide the patient row from a non-manager raiser, degrade politely.
  return r.patient?.full_name || r.patient?.patient_code || 'Patient (restricted)';
}

// One patient, one name, however many flags they carry. A single flag renders
// exactly as it always did; only a repeat gets the wrapper, so the common case
// is untouched.
function groupByPatient(list) {
  const order = [];
  const byPatient = new Map();
  list.forEach(r => {
    const key = r.patient?.id || r.patient_id || ('unknown:' + r.id);
    if (!byPatient.has(key)) { byPatient.set(key, []); order.push(key); }
    byPatient.get(key).push(r);
  });
  return order.map(key => {
    const flags = byPatient.get(key);
    if (flags.length === 1) return concernCard(flags[0]);
    const first = flags[0];
    return `
      <div class="card" style="padding:10px 12px;border-left:4px solid ${SEV_COLOR[first.severity] || 'var(--line)'}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="btn btn-ghost btn-sm" data-open-patient="${first.patient?.id || ''}" ${first.patient?.id ? '' : 'disabled'}
            style="padding:2px 8px;font-weight:700;font-size:15px">${patientName(first)}</button>
          <span class="badge badge-warn">${flags.length} separate flags</span>
          <span class="hist-meta">${first.patient?.patient_code || ''}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;padding-left:6px;border-left:2px solid var(--line)">
          ${flags.map(f => concernCard(f, true)).join('')}
        </div>
      </div>`;
  }).join('');
}

function concernCard(r, compact = false) {
  const reason = concernReason(r.reason);
  const acked = r.status === 'acknowledged';
  const canAct = isManagerOrAdmin();
  const place = [r.patient?.city, r.patient?.state].filter(Boolean).join(', ');
  const phone = primaryPhone(r);
  return `
    <div class="${compact ? '' : 'card'}" style="padding:${compact ? '4px 2px' : '12px 14px'}${compact ? '' : `;border-left:4px solid ${SEV_COLOR[r.severity] || 'var(--line)'}`}">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${compact ? '' : `<button class="btn btn-ghost btn-sm" data-open-patient="${r.patient?.id || ''}" ${r.patient?.id ? '' : 'disabled'}
              style="padding:2px 8px;font-weight:700;font-size:14.5px">${patientName(r)}</button>`}
            <span class="badge badge-neutral">${reason.label}</span>
            ${r.reassign_status === 'pending' ? `<span class="badge badge-danger" title="This mentor asked to be taken off this patient. The patient is already off her list.">Asked to be taken off</span>` : ''}
            ${r.reassign_status === 'done' ? `<span class="badge badge-ok">Reassigned</span>` : ''}
            ${r.reassign_status === 'declined' ? `<span class="badge badge-neutral">Reassignment declined</span>` : ''}
            ${acked ? `<span class="badge badge-primary">Being handled · ${r.acknowledger?.full_name || ''}</span>` : ''}
            ${r.source === 'auto' ? `<span class="badge badge-gold" title="Raised automatically from a score threshold">Auto-flag</span>` : ''}
            <span class="hist-meta">${r.patient?.patient_code || ''}${place ? ' · ' + place : ''}</span>
            ${phone ? `<a class="cg-call" href="tel:${phone.replace(/[^+\d]/g, '')}" style="padding:3px 9px;font-size:13px"
              onclick="event.stopPropagation()">${icon('phone')}<span class="tnum">${sanitizeText(phone)}</span></a>` : ''}
          </div>
          ${r.note ? `<p style="font:var(--t-sm);color:var(--ink-2);margin:7px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${r.note}</p>` : ''}
          ${reviewLine(r)}
          <div class="hist-meta" style="margin-top:6px">
            ${r.source === 'auto' ? 'Flagged automatically' : `Raised by ${r.raiser?.full_name || 'N/A'}`} · ${formatRelativeTime(r.created_at)}
          </div>
        </div>
        ${canAct ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${r.reassign_status === 'pending' ? `
          <button class="btn btn-danger btn-sm" data-reassign="${r.id}">${icon('users')}Hand to someone else</button>
          <button class="btn btn-ghost btn-sm" data-decline-reassign="${r.id}">Decline</button>` : ''}
          ${acked ? '' : `<button class="btn btn-secondary btn-sm" data-ack="${r.id}">${icon('check')}I'm on it</button>`}
          <button class="btn btn-primary btn-sm" data-resolve="${r.id}">${icon('checkCircle')}Resolve</button>
        </div>` : ''}
      </div>
    </div>`;
}

// ---- Reassignment requests (sql/113) --------------------------------
// A mentor who asked to be taken off a patient is already off them: the
// RPC cancelled her queue row when she asked. What is left for a
// supervisor is the only part a person has to decide - who picks them up.
async function openReassignModal(id) {
  const r = rows.find(x => x.id === id);
  const sb = getSupabase();
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      <strong>${patientName(r || {})}</strong> is off ${sanitizeText(r?.raiser?.full_name || 'the mentor')}'s list already.
      Choose who takes them on. They are queued for the new mentor straight away.</p>
    ${r?.note ? `<p style="font:var(--t-sm);color:var(--ink-2);background:var(--surface-2);border-radius:var(--r-sm);padding:10px 12px;margin:0 0 var(--s4)">${sanitizeText(r.note)}</p>` : ''}
    <div class="field"><label class="form-label" for="rs-to">Hand to</label>
      <select class="form-select" id="rs-to" style="width:100%"><option value="">Loading the team…</option></select></div>
    <div class="form-actions" style="margin-top:var(--s4)">
      <button class="btn btn-secondary" id="rs-cancel">Cancel</button>
      <button class="btn btn-primary" id="rs-save" disabled>${icon('users')}Hand over</button>
    </div>`;
  showModal({ title: 'Give this patient to someone else', content: el, size: 'md' });
  el.querySelector('#rs-cancel').addEventListener('click', () => closeModal());

  const sel = el.querySelector('#rs-to');
  try {
    const { data, error } = await sb.rpc('get_team_availability');
    if (error) throw error;
    // Never offer the person who asked to be taken off - AND never offer
    // somebody assign_patients() will refuse. get_team_availability returns
    // managers and admins too (sql/57), and assign_patients raises
    // 'Target must be an active caregiver mentor' on any of them, so picking
    // one rolled the whole hand-over back with a red toast. team.js:622 has
    // always filtered this list; this modal never did. That is the whole of
    // "manual reassignment is not consistently working".
    const options = (data || [])
      .filter(m => m.caller_id !== r?.reassign_from)
      .filter(m => ['caller', 'caregiver_mentor'].includes(m.role));
    if (!options.length) {
      sel.innerHTML = `<option value="">No other caregiver mentor to hand them to</option>`;
      showToast('There is no other active caregiver mentor to take this patient.', 'warning');
      return;
    }
    sel.innerHTML = `<option value="">Pick a caregiver mentor…</option>`
      + options.map(m => `<option value="${m.caller_id}">${sanitizeText(m.full_name)}${m.available === false ? ' · off today' : ''}</option>`).join('');
  } catch (e) {
    sel.innerHTML = `<option value="">Could not load the team</option>`;
    showToast('Could not load the team: ' + e.message, 'error');
    return;
  }
  const save = el.querySelector('#rs-save');
  sel.addEventListener('change', () => { save.disabled = !sel.value; });
  save.addEventListener('click', async () => {
    save.disabled = true; save.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Handing over…';
    try {
      const { data, error } = await sb.rpc('reassign_from_concern', { p_concern_id: id, p_to: sel.value });
      if (error) throw error;
      // Read the response before claiming anything happened. sql/116 makes the
      // function raise when nothing moved, but this client also refuses to
      // report a hand-over it cannot see, because the old code threw the
      // payload away and rendered "Reassigned" over an assignment that had
      // been silently skipped - leaving the patient with the mentor who asked
      // to be taken off them. Same rule as sql/68 and patients.js.
      const moved = Number(data?.assigned?.assigned ?? 0);
      if (!moved) throw new Error('the server did not confirm the hand-over, so nothing was changed');
      closeModal();
      showToast('Handed over. They are on the new mentor\'s list from today.', 'success');
      await load();
    } catch (e) {
      showToast('Could not hand over: ' + e.message, 'error');
      save.disabled = false; save.innerHTML = `${icon('users')}Hand over`;
    }
  });
}

async function openDeclineReassignModal(id) {
  const r = rows.find(x => x.id === id);
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      ${patientName(r || {})} goes back onto ${sanitizeText(r?.raiser?.full_name || 'the mentor')}'s list on the next daily build.
      Say why, in one line. They will read it.</p>
    <div class="field"><textarea class="textarea" id="dr-note" placeholder="What you decided, and what she should do if it happens again…"></textarea></div>
    <div class="form-actions" style="margin-top:var(--s4)">
      <button class="btn btn-secondary" id="dr-cancel">Cancel</button>
      <button class="btn btn-primary" id="dr-save">Decline the request</button>
    </div>`;
  showModal({ title: 'Decline the reassignment', content: el, size: 'md' });
  el.querySelector('#dr-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#dr-save').addEventListener('click', async () => {
    const btn = el.querySelector('#dr-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Saving…';
    try {
      const { error } = await getSupabase().rpc('decline_patient_reassignment', {
        p_concern_id: id, p_note: el.querySelector('#dr-note').value.trim() || null,
      });
      if (error) throw error;
      closeModal();
      showToast('Declined, with your note on the flag.', 'success');
      await load();
    } catch (e) {
      showToast('Could not decline: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = 'Decline the request';
    }
  });
}

async function acknowledge(id) {
  const sb = getSupabase();
  const me = getCurrentProfile();
  try {
    await mustWrite(sb.from('patient_concerns')
      .update({ status: 'acknowledged', acknowledged_by: me.id, acknowledged_at: new Date().toISOString() })
      .eq('id', id), 'concern');
    showToast("Marked as yours. It's being handled", 'success');
    await load();
  } catch (e) { showToast('Could not update: ' + e.message, 'error'); }
}

function openResolveModal(id) {
  const r = rows.find(x => x.id === id);
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      What was done for <strong>${patientName(r || {})}</strong>? One honest line. It becomes the record.</p>
    <div class="form-group"><label class="form-label">Resolution</label>
      <textarea class="textarea" id="rc-note" placeholder="e.g., Spoke with the family, connected them to the financial-aid desk, follow-up set for Monday…"></textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="rc-cancel">Cancel</button>
      <button class="btn btn-primary" id="rc-save">${icon('checkCircle')}Mark resolved</button>
    </div>`;
  showModal({ title: 'Resolve concern', content: el, size: 'lg' });
  el.querySelector('#rc-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#rc-save').addEventListener('click', async () => {
    const note = el.querySelector('#rc-note').value.trim();
    if (!note) { showToast('Please note what was done. Future you will thank you', 'warning'); return; }
    const btn = el.querySelector('#rc-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    const sb = getSupabase();
    const me = getCurrentProfile();
    try {
      await mustWrite(sb.from('patient_concerns')
        .update({ status: 'resolved', resolved_by: me.id, resolved_at: new Date().toISOString(), resolution_note: note })
        .eq('id', id), 'resolution');
      closeModal();
      showToast('Resolved. Thank you for closing the loop', 'success');
      await load();
    } catch (e) {
      showToast('Could not resolve: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('checkCircle')}Mark resolved`;
    }
  });
}
