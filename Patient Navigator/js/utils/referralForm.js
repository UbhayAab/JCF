// ============================================================
// Patient Navigator: the GI referral form's answers, in the team's words
//
// The public form (jarurat-care.pages.dev/gi, Fixboard #25) stores each
// submission in referral_forms (sql/164, 167, 194). The answer ids are the
// form's own (E:/claude/jcf-refer public/js/rules.mjs) and
// submit_referral_form() maps the same ids: change them there, here and in
// the RPC together. Read by the Form referrals page, the family's record and
// the Calling Portal. Everything a family typed comes from a public page and
// goes through sanitize().
// ============================================================

import { sanitize } from './validators.js';
import { formatDate, formatDateTime } from './formatters.js';

const FILLED_BY = { patient: 'The patient', family: 'A family member or caregiver' };
const CANCER = {
  oesophagus: 'Food pipe (oesophagus)', stomach: 'Stomach', liver: 'Liver', gallbladder: 'Gallbladder',
  bile_duct: 'Bile duct', pancreas: 'Pancreas', small_intestine: 'Small intestine',
  colorectal: 'Large bowel or rectum', anal: 'Anus', other_gi: 'Another digestive cancer', not_sure: 'Not sure yet',
};
const TREATMENT = {
  tests: 'Tests going on, cancer not confirmed yet', diagnosed: 'Cancer confirmed, treatment not started',
  on_treatment: 'On treatment (surgery, chemo or radiation)', finished: 'Treatment finished, in follow-up',
  palliative: 'Treatment stopped, or comfort and pain care', not_sure: 'Not sure',
};
const NEEDS = {
  understand: 'Understanding the illness and treatment', hospital: 'Right hospital or doctor, second opinion',
  money: 'Money: costs, schemes, financial help', food: 'Food and nutrition', emotional: 'Emotional support',
  travel: 'Travel and a place to stay', home_care: 'Care at home, pain relief', other: 'Something else',
};
const CONTACT = { call: 'Phone call', whatsapp: 'WhatsApp', either: 'Call or WhatsApp' };
const OUTCOME = {
  new_lead: { label: 'New family', badge: 'badge-info' },
  known_family: { label: 'Already a family', badge: 'badge-warn' },
  held: { label: 'Held, no family made', badge: 'badge-danger' },
};

// Every column the screens show. caregiver_phone and cancer_stage are sql/194.
export const REFERRAL_COLUMNS = 'id, created_at, lang, form_version, patient_name, phone, caregiver_phone, filled_by, '
  + 'city, hospital, cancer, cancer_stage, treatment, needs, needs_other, contact_method, consent_text, consent_at, '
  + 'outcome, patient_id';

const label = (map, id) => map[id] || id || '';
const MAPS = { filled_by: FILLED_BY, cancer: CANCER, treatment: TREATMENT, contact: CONTACT };
// One answer in words, for a CSV or a line of text: referralLabel('treatment', 'tests').
export const referralLabel = (kind, id) => (kind === 'outcome' ? (OUTCOME[id]?.label || id || '') : label(MAPS[kind] || {}, id));
export const outcomeBadge = (o) => {
  const x = OUTCOME[o] || { label: o, badge: 'badge-neutral' };
  return `<span class="badge ${x.badge}">${sanitize(x.label)}</span>`;
};
export const cancerLabel = (id) => label(CANCER, id);
export const needsText = (r) => (r.needs || []).map((n) => label(NEEDS, n)).join(', ')
  + (r.needs_other ? ` ("${r.needs_other}")` : '');

const telLink = (phone) => phone
  ? `<a class="tnum" href="tel:${sanitize(String(phone).replace(/[^\d+]/g, ''))}">${sanitize(phone)}</a>`
  : '';

// The searchable words of one referral, for a page's search box.
export function referralSearchText(r) {
  return [r.patient_name, r.phone, r.caregiver_phone, r.city, r.hospital, cancerLabel(r.cancer), r.cancer_stage,
    label(TREATMENT, r.treatment), needsText(r)].filter(Boolean).join(' ').toLowerCase();
}

// Every answer of one referral as a key/value grid. A blank answer reads
// "Not given", so nobody wonders whether the form asked.
export function referralFieldsHTML(r, { withName = true } = {}) {
  const has = (html) => `<div class="v">${html}</div>`;
  const none = (text = 'Not given') => `<div class="v dim">${text}</div>`;
  const text = (v) => (v ? has(sanitize(String(v))) : none());
  const cells = [
    withName ? ['Patient (as written)', text(r.patient_name)] : null,
    ["Patient's number", r.phone ? has(telLink(r.phone)) : none()],
    ["Caregiver's number", r.caregiver_phone ? has(telLink(r.caregiver_phone)) : none()],
    ['Filled in by', text(label(FILLED_BY, r.filled_by))],
    ['City or town', text(r.city)],
    ['Hospital', r.hospital ? text(r.hospital) : none('Not started, or not given')],
    ['Cancer', text(cancerLabel(r.cancer))],
    ['Stage (as written)', text(r.cancer_stage)],
    ['Treatment now', text(label(TREATMENT, r.treatment))],
    ['Help they asked for', text(needsText(r))],
    ['Contact by', text(label(CONTACT, r.contact_method))],
    ['Form language', has(r.lang === 'en' ? 'English' : 'Hindi')],
    ['Sent', has(sanitize(formatDateTime(r.created_at)))],
  ].filter(Boolean);
  return `<div class="kv">${cells.map(([k, v]) => `<div><div class="k">${k}</div>${v}</div>`).join('')}</div>`;
}

// The exact words the person ticked, folded away: it is the record of consent
// to be contacted, not consent to care, which the mentor still takes.
export function consentHTML(r) {
  if (!r.consent_text) return '';
  return `<details class="due-meta wraps" style="margin-top:8px">
    <summary style="cursor:pointer">Consent to be contacted: ticked ${sanitize(formatDateTime(r.consent_at || r.created_at))} (form ${sanitize(r.form_version || '')})</summary>
    <p style="margin:6px 0 0;white-space:pre-wrap">${sanitize(r.consent_text)}</p>
  </details>`;
}

// The newest referral of one family, folded, for the Calling Portal: open on a
// first call (a new lead), closed once the family is being looked after.
export function referralBriefHTML(r, { open = false } = {}) {
  return `<details class="history" ${open ? 'open' : ''} style="border-top:1px solid var(--line);padding-top:var(--s4)">
    <summary class="info-label" style="cursor:pointer;margin-bottom:6px">From the GI referral form, ${sanitize(formatDate(r.created_at))}</summary>
    ${referralFieldsHTML(r)}
  </details>`;
}
