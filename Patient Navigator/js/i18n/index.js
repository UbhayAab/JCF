// ============================================================
// Patient Navigator: the message catalogue
//
// There was no i18n anywhere in this app. The only language lever was a
// two-option select posted as a `lang` flag to an edge function in another
// project, so nobody working here could answer "what does a patient actually
// receive in Hindi".
//
// This is deliberately small and dependency-free, in the same vanilla style
// as the rest of js/. It does four things and nothing else:
//
//   1. a catalogue per language, keyed by a stable string id
//   2. interpolation of {named} slots
//   3. a plural rule, because "1 place" and "3 places" differ in both
//      English and Hindi
//   4. fall back to English when a string is missing, and SAY SO to the
//      navigator rather than silently sending half a language
//
// SCOPE: patient-facing text only. The staff console stays in English on
// purpose. A mentor and a patient need different registers, and translating
// the console would double the surface for no field benefit.
//
// ADDING MARATHI: write js/i18n/mr.js with the same keys, import it, add one
// row to LANGUAGES and one entry to CATALOGUES. Nothing else in the app
// changes, because nothing else in the app knows the language names. That is
// the whole reason the ids are flat strings and the catalogues are plain
// objects.
// ============================================================

import { EN } from './en.js';
import { HI } from './hi.js';

export const FALLBACK_LANG = 'en';

// `native` is what the navigator sees in the picker. A Hindi speaker
// choosing a language should see the word in her own script.
export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'hi', label: 'Hindi',   native: 'हिंदी' },
  // { code: 'mr', label: 'Marathi', native: 'मराठी' },   <- js/i18n/mr.js
];

const CATALOGUES = {
  en: EN,
  hi: HI,
};

export const isLanguage = (code) => Object.prototype.hasOwnProperty.call(CATALOGUES, code);
export const languageLabel = (code) => (LANGUAGES.find(l => l.code === code) || LANGUAGES[0]).native;

// ------------------------------------------------------------
// patients.primary_language is free text and dirty enough that sql/65 had to
// build a 33 value canonicaliser for it after finding "Tata", "Memorial" and
// "Caregiver" filed as languages. So this never trusts it blindly: it looks
// for a language we can actually write, and returns null when it finds none,
// which lets the caller fall back to the org default instead of guessing.
// ------------------------------------------------------------
export function normaliseLang(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  if (isLanguage(s)) return s;
  if (/\bmarathi\b|मराठी/.test(s)) return isLanguage('mr') ? 'mr' : 'hi';
  if (/\bhind|हिंदी|हिन्दी|\bhi\b/.test(s)) return 'hi';
  if (/\bengl|\ben\b/.test(s)) return 'en';
  // Bengali, Bhojpuri, Odia and the rest have no catalogue yet. Hindi is the
  // link language nearly every one of those families also reads, and it is
  // what the ward speaks, so it is a better answer than English. Marked as a
  // guess by the caller through wasGuessed().
  if (/\bbeng|bangla|bhojpuri|odia|oriya|maithili|awadhi|urdu/.test(s)) return 'hi';
  return null;
}

// True when normaliseLang picked Hindi as a stand-in rather than because the
// record says Hindi. The share screen shows this so a navigator can correct it.
export function wasGuessed(raw) {
  const s = String(raw || '').toLowerCase().trim();
  return !!s && !/\bhind|हिंदी|हिन्दी/.test(s) && normaliseLang(s) === 'hi';
}

// ------------------------------------------------------------
// t(lang, id, vars)
//
// `vars.count` selects the plural form: an id of `x.y` looks for `x.y_one`
// or `x.y_other` first. Both English and Hindi split at exactly one, so a
// single rule covers both; a language that does not (Marathi does, Arabic
// does not) would add its own rule here rather than in every call site.
// ------------------------------------------------------------
const MISSING = [];

export function t(lang, id, vars = {}) {
  const raw = lookup(lang, id, vars);
  if (raw == null) {
    if (!MISSING.some(m => m.lang === lang && m.id === id)) MISSING.push({ lang, id });
    return '';
  }
  return interpolate(raw, vars);
}

// Same as t(), but tells you whether the string came from the requested
// language or from the English fallback. The preview uses this to mark
// untranslated lines instead of shipping a half-Hindi message unannounced.
export function tx(lang, id, vars = {}) {
  const own = lookup(lang, id, vars, true);
  if (own != null) return { text: interpolate(own, vars), fallback: false };
  const back = lookup(FALLBACK_LANG, id, vars, true);
  if (back != null) return { text: interpolate(back, vars), fallback: lang !== FALLBACK_LANG };
  if (!MISSING.some(m => m.lang === lang && m.id === id)) MISSING.push({ lang, id });
  return { text: '', fallback: true, missing: true };
}

export const has = (lang, id) => lookup(lang, id, {}, true) != null;

// Every id asked for that no catalogue could answer. Surfaced in the share
// screen's preview so a gap is found by a navigator before a patient finds it.
export const missingKeys = () => MISSING.slice();
export const resetMissing = () => { MISSING.length = 0; };

function lookup(lang, id, vars, ownOnly = false) {
  const order = ownOnly ? [lang] : [lang, FALLBACK_LANG];
  const n = vars && vars.count;
  const forms = (typeof n === 'number')
    ? [n === 1 ? `${id}_one` : `${id}_other`, id]
    : [id];
  for (const L of order) {
    const cat = CATALOGUES[L];
    if (!cat) continue;
    for (const key of forms) {
      if (typeof cat[key] === 'string') return cat[key];
    }
  }
  return null;
}

function interpolate(s, vars) {
  return s.replace(/\{(\w+)\}/g, (m, k) =>
    (vars && vars[k] != null) ? String(vars[k]) : m);
}

// ------------------------------------------------------------
// Numbers, times and dates, in the register a patient reads.
//
// Devanagari digits are NOT used. Every Indian patient reads Latin digits on
// a phone bill, a bus and a prescription, and a rupee amount written in
// Devanagari numerals would be the one line in the message that stops a
// reader cold.
// ------------------------------------------------------------
export function money(lang, n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  const s = v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return t(lang, 'fmt.rupees', { n: s });
}

// contact_hours_* arrive as a Postgres time, "10:00:00".
export function clock(lang, hhmmss) {
  if (!hhmmss) return '';
  const [hStr, mStr] = String(hhmmss).split(':');
  const h = Number(hStr), m = Number(mStr || 0);
  if (!isFinite(h)) return '';
  const h12 = ((h + 11) % 12) + 1;
  const mm = m ? ':' + String(m).padStart(2, '0') : '';
  return t(lang, 'fmt.clock', {
    h: h12, mm,
    part: t(lang, 'fmt.daypart.' + dayPart(h)),
  });
}

function dayPart(h) {
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'evening';
  return 'night';
}

export function shortDate(lang, d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return t(lang, 'fmt.date', {
    d: dt.getDate(),
    month: t(lang, 'month.' + (dt.getMonth() + 1)),
  });
}

// City names, and only city names. `xlit.<Token>` in the catalogue is looked
// up token by token, so a token with no entry is passed through untouched and
// an address can never be half rewritten. Street names, building names and
// organisation names are deliberately absent from that list: a family shows
// the address to a rickshaw driver, and it has to match what is written on
// the building.
export function place(lang, s) {
  if (!s) return '';
  return String(s).replace(/[A-Za-z]+/g, (tok) => {
    const v = lookup(lang, 'xlit.' + tok, {}, true);
    return v || tok;
  });
}

// A list of things to carry, joined the way the language joins lists.
export function joinList(lang, items) {
  const xs = items.filter(Boolean);
  if (!xs.length) return '';
  if (xs.length === 1) return xs[0];
  const sep = t(lang, 'fmt.list_sep') || ', ';
  const last = t(lang, 'fmt.list_last') || ' and ';
  return xs.slice(0, -1).join(sep) + last + xs[xs.length - 1];
}
