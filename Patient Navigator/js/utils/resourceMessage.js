// ============================================================
// Patient Navigator: what the family actually receives
//
// The old message was `title + summary + eligibility` for up to twelve rows,
// straight out of the database, in a language nobody chose. `summary` and
// `eligibility` are STAFF prose. The schema calls them "one-paragraph what
// this is" and "who can use it / documents needed". So a family got twelve
// paragraphs written for a colleague, with no order, no "start here", and no
// statement of what they will be asked for when they arrive.
//
// This module produces a TEMPLATE with named slots instead. Nothing here
// concatenates a translated sentence out of pieces; every sentence is one
// catalogue entry with {named} holes, because a Hindi sentence is not an
// English sentence with the words swapped and word order has to be free to
// move. That is also why plan() and render() are separate: plan() decides
// WHAT to say using only the data, render() decides HOW to say it using only
// the language. Adding Marathi touches render() not at all.
//
// The five slots, in this order, every block, every time:
//
//   what    what the family GETS. Never the organisation's mission, never
//           its name first. "A place to stay near the hospital, no charge."
//   who     who it is for, so a family reads the age line before they travel
//   bring   the papers, as a short list, never as prose
//   do      exactly ONE concrete next action
//   expect  the honest part. Rooms are usually full. Nobody answers this
//           phone. We have never actually called them.
//
// Constraints that come from the reader, not from us: a basic phone, a
// WhatsApp thread, a corridor, and a diagnosis three days old. Short lines.
// Numbered blocks so a navigator can say "look at number 3". Three resources
// by default, because twelve is a list and three is a plan.
// ============================================================

import { t, tx, money, clock, shortDate, joinList, place, FALLBACK_LANG } from '../i18n/index.js';

// The template is data, not code, so the order of the slots can be seen and
// argued about in one place.
export const MESSAGE_TEMPLATE = {
  id: 'resource_list_v2',
  slots: [
    { key: 'what',   labelId: 'block.what' },
    { key: 'who',    labelId: 'block.who' },
    { key: 'bring',  labelId: 'block.bring' },
    { key: 'do',     labelId: 'block.do' },
    { key: 'phone',  labelId: 'block.phone' },
    { key: 'expect', labelId: null },   // no label: it is a plain sentence, not a field
  ],
};

export const DEFAULT_MAX_BLOCKS = 3;
export const HARD_MAX_BLOCKS = 5;

// A value that has to be formatted in the target language rather than baked
// in at plan time. { fmt:'money', v:500 } becomes "Rs 500" or "500 रुपये".
const fmt = (kind, v) => ({ __fmt: kind, v });

// ============================================================
// plan(): data in, language-independent structure out
// ============================================================

// item = { resource: <row from public.resources>, match: <row from match_resources()> }
export function planBlock(item, patient, index) {
  const r = item.resource || {};
  const m = item.match || {};
  const blockers = m.blockers || [];
  const isStay = r.category === 'accommodation';

  return {
    n: index + 1,
    // Verbatim. This is what is painted on the building and what the family
    // will say at the desk, so it is never translated and never shortened.
    name: cleanName(r.title),
    place: shortPlace(r),
    what:   whatSlot(r, isStay),
    who:    whoSlot(r),
    bring:  bringSlot(r),
    do:     doSlot(r, patient),
    phone:  (r.contact_phone || '').trim() || null,
    expect: expectSlot(r, m, blockers),
    // carried through for the console only, never rendered to a patient
    _fit: m.fit || null,
    _id: r.id,
  };
}

export function planMessage({ patient = {}, poc = {}, items = [], totalAvailable = null,
                             maxBlocks = DEFAULT_MAX_BLOCKS } = {}) {
  const shown = items.slice(0, Math.min(maxBlocks, HARD_MAX_BLOCKS));
  const blocks = shown.map((it, i) => planBlock(it, patient, i));

  const cats = new Set(shown.map(it => (it.resource || {}).category));
  const kind = cats.size === 1 ? [...cats][0] : 'mixed';
  const introBase = (kind === 'accommodation' || kind === 'financial_aid')
    ? 'msg.intro.' + kind
    : 'msg.intro.mixed';

  const name = firstName(patient.full_name);
  const pocName = firstName(poc.full_name);

  const remaining = (totalAvailable == null) ? 0 : Math.max(0, totalAvailable - shown.length);

  return {
    greeting: name
      ? (pocName ? { id: 'msg.greeting', vars: { name, poc: pocName } }
                 : { id: 'msg.greeting_no_poc', vars: { name } })
      : (pocName ? { id: 'msg.greeting_no_name', vars: { poc: pocName } } : null),
    intro: { id: introBase, vars: { count: shown.length } },
    blocks,
    more: remaining > 0 ? { id: 'msg.more_available', vars: { count: remaining } } : null,
    closing: poc.phone
      ? { id: 'msg.closing', vars: { phone: poc.phone } }
      : { id: 'msg.closing_no_phone', vars: {} },
    signoff: pocName ? { id: 'msg.signoff', vars: { poc: pocName } }
                     : { id: 'msg.signoff_no_poc', vars: {} },
  };
}

// ---- slot 1: lead with what they GET -------------------------------------
function whatSlot(r, isStay) {
  const area = shortPlace(r);
  const lo = numOrNull(r.amount_min_inr);
  const hi = numOrNull(r.amount_max_inr);

  if (isStay) {
    const A = fmt('place_name', area);
    if (lo === 0) {
      return area ? { id: 'what.room_free_at', vars: { area: A } } : { id: 'what.room_free', vars: {} };
    }
    if (lo != null && hi != null && hi > lo) {
      return { id: 'what.room_range', vars: { area: A, min: fmt('money', lo), max: fmt('money', hi) } };
    }
    if (lo != null && hi != null && hi === lo) {
      return { id: 'what.room_price', vars: { area: A, price: fmt('money', lo) } };
    }
    if (lo != null) return { id: 'what.room_from', vars: { area: A, price: fmt('money', lo) } };
    return { id: 'what.room', vars: { area: A } };
  }

  const BY_SUBTYPE = {
    govt_scheme:       'what.govt_scheme',
    hospital_fund:     'what.hospital_fund',
    crowdfunding:      'what.crowdfunding',
    medicine_support:  'what.medicines',
    travel_support:    'what.travel',
    equipment_support: 'what.equipment',
    insurance:         'what.insurance',
    ngo_grant:         'what.grant',
  };
  return { id: BY_SUBTYPE[r.subtype] || 'what.help', vars: {} };
}

// ---- slot 2: who it is for -----------------------------------------------
function whoSlot(r) {
  const out = [];
  const lo = numOrNull(r.age_min);
  const hi = numOrNull(r.age_max);

  if (lo != null && hi != null)      out.push({ id: 'who.age_between', vars: { min: lo, max: hi } });
  else if (hi != null)               out.push({ id: 'who.up_to_age', vars: { age: hi } });
  else if (lo != null)               out.push({ id: 'who.from_age', vars: { age: lo } });
  else                               out.push({ id: 'who.any_age', vars: {} });

  if (r.gender_served === 'female')  out.push({ id: 'who.women', vars: {} });
  if (r.gender_served === 'male')    out.push({ id: 'who.men', vars: {} });

  if (r.serves_caregivers) {
    const n = numOrNull(r.caregiver_count_max);
    out.push(n != null ? { id: 'who.attendant', vars: { count: n } }
                       : { id: 'who.attendant_any', vars: {} });
  }
  return out;
}

// ---- slot 3: the papers, as a list ---------------------------------------
function bringSlot(r) {
  const req = (r.documents_required || []).filter(Boolean);
  const opt = (r.documents_optional || []).filter(Boolean);
  return { required: req, optional: opt };
}

// ---- slot 4: exactly one action ------------------------------------------
function doSlot(r, patient) {
  const out = [];
  const hospital = hospitalId(patient.treating_hospital);
  const hasPhone = !!(r.contact_phone || '').trim();
  const visit = r.physical_visit_required === true;

  if (visit && hasPhone)       out.push({ id: 'do.call_then_visit', vars: {} });
  else if (visit)              out.push({ id: 'do.visit', vars: {} });
  else if (hasPhone && r.contact_hours_from && r.contact_hours_to) {
    out.push({ id: 'do.call_hours', vars: {
      from: fmt('clock', r.contact_hours_from),
      to: fmt('clock', r.contact_hours_to),
      hospital: fmt('place', hospital),
    } });
  } else if (hasPhone) {
    out.push({ id: 'do.call', vars: { hospital: fmt('place', hospital) } });
  } else if (r.link) {
    out.push({ id: 'do.apply_online', vars: { link: r.link } });
  } else {
    out.push({ id: 'do.visit', vars: {} });
  }

  if (r.ask_for_name) out.push({ id: 'do.call_ask_for', vars: { name: r.ask_for_name } });
  // The address is a proper noun and is passed through untranslated. It is
  // last so the action is read first.
  if (r.address && (visit || !hasPhone)) out.push({ id: 'do.address', vars: { address: r.address } });

  return out;
}

// ---- slot 5: the honest part ---------------------------------------------
// Capped at two lines. Three warnings on one shelter reads as "do not go".
function expectSlot(r, m, blockers) {
  const out = [];
  const has = (k) => blockers.includes(k);

  // A missing paper is the single most useful warning we can give, so it
  // outranks everything else and is named.
  for (const b of blockers) {
    if (b.startsWith('missing_document:')) {
      out.push({ id: 'expect.missing_document', vars: { doc: fmt('doc', b.split(':')[1]) } });
      break;
    }
  }
  if (has('papers_never_asked_about')) out.push({ id: 'expect.papers_unknown', vars: {} });
  if (has('must_go_in_person'))        out.push({ id: 'expect.must_go_in_person', vars: {} });
  if (has('phone_never_answered'))     out.push({ id: 'expect.phone_never_answered', vars: {} });
  else if (has('phone_hard_to_reach')) out.push({ id: 'expect.phone_hard_to_reach', vars: {} });
  if (has('no_phone_number'))          out.push({ id: 'expect.no_phone_number', vars: {} });
  if (has('waiting_list'))             out.push({ id: 'expect.waiting_list', vars: {} });
  if (has('free_rooms_fill_up'))       out.push({ id: 'expect.free_rooms_fill_up', vars: {} });
  if (r.typical_wait_days > 14)        out.push({ id: 'expect.takes_days', vars: { days: r.typical_wait_days } });

  // Good news, when we have it, goes last and is dated so it can be trusted.
  if (r.availability === 'open' && r.availability_checked_on) {
    out.push({ id: 'expect.checked_on', vars: { date: fmt('date', r.availability_checked_on) } });
  } else if (has('never_phoned_by_us')) {
    out.push({ id: 'expect.never_phoned_by_us', vars: {} });
  } else if (has('not_checked_in_a_year')) {
    out.push({ id: 'expect.not_checked_in_a_year', vars: {} });
  }

  return out.slice(0, 2);
}

// ============================================================
// render(): structure in, one language out
// ============================================================

export function renderMessage(plan, lang) {
  const L = lang || FALLBACK_LANG;
  const fb = [];      // ids that fell back to English
  const say = (node) => {
    if (!node) return '';
    const r = tx(L, node.id, resolveVars(node.vars, L));
    if (r.fallback && !r.missing) fb.push(node.id);
    if (r.missing) fb.push(node.id + ' (MISSING)');
    return r.text;
  };

  // Each block renders as { fixed, advice }. `advice` is the sentences that
  // are true of the PLACE rather than fields of it: the rooms fill up fast,
  // we have never actually phoned them, nobody told us what to carry.
  const rendered = plan.blocks.map(b => renderBlockLines(b, L, say));

  // Three identical warnings under three identical shelters is a wall of
  // text, and a family stops reading walls. Anything true of EVERY block is
  // said once at the end, where it reads as one honest note instead of
  // three. This is the difference between 1900 characters and 1200.
  const shared = (rendered.length > 1)
    ? rendered[0].advice.filter(a => rendered.every(r => r.advice.includes(a)))
    : [];

  const lines = [];
  const g = say(plan.greeting); if (g) lines.push(g);
  const i = say(plan.intro);    if (i) lines.push(i);
  lines.push('');

  plan.blocks.forEach((b, idx) => {
    // LEAD WITH WHAT THEY GET. The organisation's name is the second line,
    // because a family decides on the offer and only then needs the name to
    // say at the desk. WhatsApp renders *text* in bold, which is the only
    // formatting a basic phone reliably shows, so the offer is the one thing
    // that can be read without reading.
    const headline = say(b.what);
    lines.push('*' + b.n + '. ' + (headline || b.name) + '*');
    if (headline) lines.push(b.name);
    lines.push(...rendered[idx].fixed);
    lines.push(...rendered[idx].advice.filter(a => !shared.includes(a)));
    lines.push('');
  });

  if (shared.length) { lines.push(...shared); lines.push(''); }

  const more = say(plan.more); if (more) { lines.push(more); lines.push(''); }
  const c = say(plan.closing); if (c) lines.push(c);
  const s = say(plan.signoff); if (s) lines.push(s);

  return {
    lang: L,
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    fallbacks: [...new Set(fb)],
    sharedNotes: shared,
  };
}

// One block, as the lines a family reads, split into the fields of THIS
// place and the advice that may be true of every place on the list.
// Exported because the preview renders block by block and must not
// re-implement the order.
export function renderBlockLines(b, lang, sayFn) {
  const say = sayFn || ((node) => node ? t(lang, node.id, resolveVars(node.vars, lang)) : '');
  const label = (id) => id ? t(lang, id) : null;
  const fixed = [];
  const advice = [];

  const push = (labelId, value) => {
    if (!value) return;
    const lb = label(labelId);
    fixed.push(lb ? lb + ': ' + value : value);
  };

  push('block.who', b.who.map(say).filter(Boolean).join(' '));

  const req = b.bring.required.map(k => t(lang, 'doc.' + k)).filter(Boolean);
  if (req.length) {
    push('block.bring', joinList(lang, req));
    const opt = b.bring.optional.map(k => t(lang, 'doc.' + k)).filter(Boolean);
    if (opt.length) fixed.push(t(lang, 'bring.also_helpful', { items: joinList(lang, opt) }));
  } else {
    // Nobody has told us what to carry, which is true of 611 of the 617 rows
    // in the library, so this belongs in the shared note at the end rather
    // than three times over.
    advice.push(t(lang, 'bring.nothing_listed'));
  }

  push('block.do', b.do.map(say).filter(Boolean).join(' '));
  if (b.phone) push('block.phone', b.phone);

  b.expect.map(say).filter(Boolean).forEach(x => advice.push(x));
  return { fixed, advice };
}

// ============================================================
// helpers
// ============================================================

function resolveVars(vars, lang) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (v && typeof v === 'object' && v.__fmt) {
      out[k] = v.__fmt === 'money' ? money(lang, v.v)
             : v.__fmt === 'clock' ? clock(lang, v.v)
             : v.__fmt === 'date'  ? shortDate(lang, v.v)
             : v.__fmt === 'doc'   ? t(lang, 'doc.' + v.v)
             : v.__fmt === 'place' ? (t(lang, v.v) || v.v)
             : v.__fmt === 'place_name' ? place(lang, v.v)
             : String(v.v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// The directory carries a handful of organisation names with an en dash in
// them, which is their registered name and is not ours to rewrite (sql/82
// says so at length). It is still not going into a patient message with a
// character half the phones in a ward render as a box.
function cleanName(title) {
  return String(title || '').replace(/[\u2013\u2014]/g, '-').trim();
}

// The area a family would name to an auto driver. The full address is a
// separate line; putting it in the first sentence would bury the offer.
function shortPlace(r) {
  const city = (r.city || (r.serves_cities || [])[0] || r.near_hospital || '').trim();
  const a = (r.address || '').trim();
  if (!a) return city;
  if (a.length <= 34 && !a.includes(',')) return a;

  // Indian addresses run building, lane, landmark, LOCALITY, CITY PIN. A
  // family needs the last two, not the first four. "Chembur, Mumbai" is what
  // they will say to a rickshaw driver; the full string is on the "what to
  // do" line already, for anyone who needs it.
  const parts = a.split(',').map(x => x.trim())
    .map(x => x.replace(/\b\d{6}\b/g, '').trim())
    .filter(x => x && !/^\d+$/.test(x));
  if (!parts.length) return city;
  const two = parts.slice(-2).join(', ');
  if (two.length <= 34) return two;
  const one = parts[parts.length - 1];
  return one.length <= 34 ? one : city;
}

// The one proper noun that is translated, because every patient here already
// reads and says it in Devanagari. Anything else is passed through verbatim.
function hospitalId(name) {
  const s = String(name || '').toLowerCase();
  if (!s || /tata|tmh|memorial/.test(s)) return 'place.tata_memorial';
  return name;
}

function firstName(full) {
  const s = String(full || '').trim();
  if (!s) return '';
  return s.split(/\s+/)[0];
}

const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
