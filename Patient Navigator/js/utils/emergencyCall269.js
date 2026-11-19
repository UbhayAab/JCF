// Fixboard #269: one tap to call the family from every emergency or urgent box.
//
// "When the interns open onto that notification or the dialogue box, they do
// not get any options for the call." Before this, a HopeBot emergency showed a
// number only to the one person it was assigned to; everyone else got
// "I will call" (a claim, not a call), and the WhatsApp leads "Log the call"
// box and the Flags & concerns boxes asked what happened on a call they could
// not start from there.
//
// Pure helpers, no imports, so a phone that pairs this file with an older
// cached page module still boots (tools/stale_import_check.mjs). Every number
// passed in here is one the screen already reads under today's permissions;
// nothing here fetches or widens access to a number.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A HopeBot request is an emergency when HopeBot routed it to everyone
// (team 'all', returned as safety) or its reason is a safety reason
// (safety_emergency "Medical emergency", safety_self_harm).
export function isEmergencyRequest269(x) {
  if (!x || typeof x !== 'object') return false;
  return x.safety === true || x.team === 'all' || String(x.reason || '').startsWith('safety_');
}

// An open "Urgent: act today" flag on Flags & concerns.
export const isUrgentConcern269 = (r) => !!r && r.severity === 'urgent' && (r.status === 'open' || r.status === 'acknowledged');

// The dial string. HopeBot stores 91XXXXXXXXXX without a plus and Patient
// Navigator stores +91 ..., 91... or a bare 10 digit number, so a number with
// more than 10 digits is dialled as international. Anything that is not 8 to
// 15 digits is not offered at all: a call button that rings nowhere is worse
// than none.
export function dialHref269(phone) {
  const kept = String(phone ?? '').replace(/[^+\d]/g, '');
  const digits = kept.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return 'tel:' + (kept.startsWith('+') || digits.length > 10 ? '+' : '') + digits;
}

// How a HopeBot number reads on screen: 919000000001 as +91 90000 00001.
// Anything else is shown as it is stored.
export function displayPhone269(phone) {
  const raw = String(phone ?? '').trim();
  const d = raw.replace(/\D/g, '');
  return !raw.startsWith('+') && d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : raw;
}

// The button. An anchor, so the tap itself dials on a phone and the default
// action is never held up by a network request; the screen records the call
// through its own path when it hears the click. attrs are fixed data-*
// names chosen by the caller; their values are escaped here.
export function callNowHTML269({ phone, shown = phone, label = 'Call now', icon = '', attrs = {}, cls = 'btn btn-gold btn-sm' } = {}) {
  const href = dialHref269(phone);
  if (!href) return '';
  const extra = Object.entries(attrs)
    .filter(([k]) => /^data-[a-z0-9-]+$/.test(k))
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const number = String(shown ?? '').trim();
  return `<a class="${esc(cls)} call-now269" href="${esc(href)}"${extra} aria-label="${esc(label)}${number ? ' ' + esc(number) : ''}">${icon}<span>${esc(label)}</span>${number ? `<span class="tnum" style="margin-left:6px">${esc(number)}</span>` : ''}</a>`;
}

// Who may open the "Log a call" sheet (components/callForm.js refuses anyone
// else). Everyone else still gets the dial itself.
export const canLogCall269 = (role) => ['caller', 'caregiver_mentor', 'nutritionist', 'therapist', 'manager', 'admin'].includes(role);
