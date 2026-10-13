// ============================================================
// Patient Navigator: confirm your WhatsApp number (Fixboard #10)
// HopeBot will know a team member by the number they use on WhatsApp (#9:
// papers a team member forwards are filed under the patient whose number
// follows them), so every active member confirms it once, right after
// signing in. "Later" puts it off for 4 hours, and only 3 times (sql/187):
// after that the sheet has no Later and no close until a number is saved.
// The database is the authority on what counts as a number
// (normalize_team_phone, sql/157); the copy below only formats and
// pre-checks so a typo is caught before the round trip.
// ============================================================

import { getCurrentUser, getRealProfile, isImpersonating, signOut } from '../auth.js';
import { getSupabase } from '../supabase.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';

const LATER_KEY = 'pn_phone_prompt_later_until';
const LATER_HOURS = 4;
const RECHECK_MS = 1500;

/** The same rule as normalize_team_phone() in sql/157; null means "not a usable mobile number". */
export function normalizeTeamPhone(raw) {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (!plus && d.length === 11 && d.startsWith('0')) d = d.slice(1);
  else if (plus) return d.length >= 8 && d.length <= 15 && d[0] !== '0' ? '+' + d : null;
  return d.length === 10 && /^[6-9]/.test(d) ? d : null;
}

/** "98765 43210" for an Indian mobile, anything else as stored. */
export function formatTeamPhone(n) {
  return /^\d{10}$/.test(n || '') ? `${n.slice(0, 5)} ${n.slice(5)}` : (n || '');
}

/** Saves and confirms the signed-in member's number; returns what was stored. */
export async function confirmMyPhone(raw) {
  const { data, error } = await getSupabase().rpc('confirm_my_phone', { p_phone: raw });
  if (error) throw new Error(error.message);
  // sql/192: a refusal is an answer, not an error, so the database can log it.
  if (data?.refused) throw new Error(data.message || 'This number cannot be saved here.');
  const prof = getRealProfile();
  if (prof) {
    prof.phone = data.phone;
    prof.phone_confirmed_at = data.phone_confirmed_at;
  }
  return data;
}

// Throwaway test accounts sign in with .invalid addresses (RFC 2606: never a
// person's), and some hundred browser checks would find this sheet over the
// page they came to test. They are not asked unless a check wants exactly that
// (tools/phone_prompt_check.mjs sets the flag).
function isTestAccount() {
  if (!/\.invalid$/i.test(getCurrentUser()?.email || '')) return false;
  try { return localStorage.getItem('pn_phone_prompt_test') !== '1'; } catch { return true; }
}

// The snooze is per account and per device, with a time on it: the Android
// app and an installed PWA keep one session alive for days, so a session-only
// flag used to mean "never again" there.
function laterKey() { return `${LATER_KEY}:${getRealProfile()?.id || ''}`; }

function snoozed() {
  try { return Number(localStorage.getItem(laterKey()) || 0) > Date.now(); } catch { return false; }
}

// Set only by "Carry on for now", which appears only on a sheet she could not
// close, after a number was refused, a save hung, or two tries were not a
// mobile number. Per account, for a few hours (the Android app keeps one
// session for days), and her managers see it on Team > Phone numbers.
const STUCK_KEY = 'pn_phone_prompt_stuck_until';
function stuckKey() { return `${STUCK_KEY}:${getRealProfile()?.id || ''}`; }
function stuck() {
  try { return Number(localStorage.getItem(stuckKey()) || 0) > Date.now(); } catch { return false; }
}

function wantsPrompt() {
  if (isImpersonating() || isTestAccount()) return false;
  const prof = getRealProfile();
  if (!prof || prof.is_active === false || prof.phone_confirmed_at) return false;
  return !snoozed() && !stuck();
}

// A live call is never interrupted: the Calling Portal's call view is on
// screen, or a call is kept to come back to (jcf_active_call_<id>, calling.js;
// it lives about a day, so an older one does not count).
const CALL_KEEP_MS = 20 * 3600 * 1000;
function inCall() {
  if (document.querySelector('#portal-content .portal-grid')) return true;
  try {
    for (const id of new Set([getCurrentUser()?.id, getRealProfile()?.id].filter(Boolean))) {
      const kept = JSON.parse(localStorage.getItem(`jcf_active_call_${id}`) || 'null');
      if (kept && (!kept.ts || Date.now() - kept.ts < CALL_KEEP_MS)) return true;
    }
  } catch { /* storage blocked */ }
  return false;
}

// Another sheet, the camera, a live call, or anything else that holds the page.
function busy() {
  return !!document.querySelector('.modal-overlay') || document.body.classList.contains('modal-open') || inCall();
}

let recheck = null;
let watching = false;
let opening = false;
function schedule(ms) { clearTimeout(recheck); recheck = setTimeout(maybeAskForPhone, ms); }

// Only a sheet that is showing counts: a replaced one lingers 250 ms while it
// fades out (modal.js), and must not stop the ask.
function phonePromptPending() {
  return opening || !!document.querySelector('.modal-overlay.active #phone-prompt-form');
}
// What's new (featureUpdates.js) waits while this is set.
function setOpening(v) {
  opening = v;
  if (v) document.body.dataset.phonePrompt = 'opening'; else delete document.body.dataset.phonePrompt;
}

/**
 * Called once the app shell is up, again on every page change, and once a
 * minute (any other sheet that opens replaces this one; it comes back after).
 * Waits for whatever holds the page to finish, then asks.
 */
export function maybeAskForPhone() {
  if (!watching) {
    watching = true;
    window.addEventListener('hashchange', () => schedule(700));
    setInterval(() => { if (!recheck) maybeAskForPhone(); }, 60000);
  }
  recheck = null;
  if (phonePromptPending() || !wantsPrompt()) return;
  if (busy()) { schedule(RECHECK_MS); return; }
  openPhonePrompt();
}

// Later (or the close button): counted by the database, which refuses a 4th.
async function putOff() {
  try { localStorage.setItem(laterKey(), String(Date.now() + LATER_HOURS * 3600e3)); } catch { /* private mode */ }
  const { data, error } = await getSupabase().rpc('note_phone_prompt', { p_event: 'later' });
  if (error) {
    if (error.code === 'P0001' || /put off/i.test(error.message || '')) {
      try { localStorage.removeItem(laterKey()); } catch { /* private mode */ }
      schedule(1500);
    }
    return;
  }
  if (data?.skips_left > 0) {
    showToast(`We will ask again in ${LATER_HOURS} hours. You can put it off ${data.skips_left} more time${data.skips_left === 1 ? '' : 's'}.`, 'info', 5000);
  } else {
    showToast(`We will ask again in ${LATER_HOURS} hours, and then it will need your number before you carry on.`, 'warning', 6000);
  }
}

const SAVE_TIMEOUT_MS = 15000;
const withTimeout = (p) => Promise.race([p, new Promise((_, no) =>
  setTimeout(() => no(new Error('Saving is taking too long. Check your connection and try again.')), SAVE_TIMEOUT_MS))]);

export async function openPhonePrompt() {
  const prof = getRealProfile();
  const prefill = prof?.phone ? formatTeamPhone(normalizeTeamPhone(prof.phone) || prof.phone) : '';
  // Counted for the managers' Team > Phone numbers list. If it fails (an old
  // database, offline), the sheet still opens with Later.
  setOpening(true);
  let mustSave = false;
  try {
    const { data } = await getSupabase().rpc('note_phone_prompt', { p_event: 'shown' });
    mustSave = !!data?.must_save;
  } catch { /* offline: ask anyway */ }
  setOpening(false);
  // Things change during that round trip: signed out, impersonating, confirmed
  // on another device, or another sheet opened.
  if (!wantsPrompt()) return;
  if (busy()) { schedule(RECHECK_MS); return; }
  const overlay = showModal({
    title: 'Hey team, we need your phone number',
    dismissible: !mustSave,
    content: `
      <form id="phone-prompt-form" novalidate>
        <p style="margin:0 0 var(--space-4);line-height:1.55">
          We will be testing HopeBot, our WhatsApp helper, and it will know you by your number.
          Please put your phone number in correctly: the one you use on WhatsApp.
        </p>
        ${mustSave ? `<p style="margin:0 0 var(--space-4);line-height:1.55"><strong>This has been put off 3 times, so please
          save it now. It takes a few seconds, and you can change it later on your Profile page.</strong></p>` : ''}
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" for="phone-prompt-input">Your WhatsApp number</label>
          <input class="form-input" id="phone-prompt-input" type="tel" inputmode="tel" autocomplete="tel"
                 maxlength="20" placeholder="98765 43210" value="${sanitize(prefill)}" />
          <span class="form-hint">The 10 digits of your mobile number. For a number outside India, start with + and the country code.</span>
          <div class="form-error" id="phone-prompt-error" role="alert" style="margin-top:var(--space-2)" hidden></div>
        </div>
        ${mustSave ? `<p class="form-hint" style="margin:var(--space-3) 0 0">Not your account?
          <a href="#" id="phone-prompt-signout">Sign out</a></p>` : ''}
      </form>`,
    footer: `
      ${mustSave ? '' : '<button type="button" class="btn btn-ghost" id="phone-prompt-later">Later</button>'}
      <button type="submit" form="phone-prompt-form" class="btn btn-primary" id="phone-prompt-save">Save my number</button>`,
    onClose: putOff,
  });

  const form = overlay.querySelector('#phone-prompt-form');
  const input = overlay.querySelector('#phone-prompt-input');
  const errorBox = overlay.querySelector('#phone-prompt-error');
  const save = overlay.querySelector('#phone-prompt-save');
  const say = (msg) => { errorBox.textContent = msg; errorBox.hidden = !msg; };
  let badTries = 0;

  overlay.querySelector('#phone-prompt-later')?.addEventListener('click', () => closeModal(putOff));
  overlay.querySelector('#phone-prompt-signout')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
    signOut();
  });
  input.addEventListener('input', () => say(''));
  setTimeout(() => input.focus(), 250);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!normalizeTeamPhone(raw)) {
      say('That does not look like a mobile number. Type the 10 digits of your number, or + and the country code for a number outside India.');
      input.focus();
      if (mustSave && ++badTries >= 2) offerWayOut(overlay);
      return;
    }
    save.disabled = true;
    save.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const saved = await withTimeout(confirmMyPhone(raw));
      closeModal();
      showToast(`Thank you. HopeBot will know you by ${formatTeamPhone(saved.phone)}.`, 'success');
    } catch (err) {
      say(err.message || 'Could not save the number. Check your connection and try again.');
      save.disabled = false;
      save.textContent = 'Save my number';
      if (mustSave) offerWayOut(overlay);
    }
  });
}

// The sheet cannot be closed after 3 Laters, but a number the database will
// not take (already on another account) or a dead connection must never lock
// her out of her work.
function offerWayOut(overlay) {
  if (overlay.querySelector('#phone-prompt-stuck')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  btn.id = 'phone-prompt-stuck';
  btn.textContent = 'Carry on for now';
  overlay.querySelector('.modal-footer')?.prepend(btn);
  btn.addEventListener('click', async () => {
    try { localStorage.setItem(stuckKey(), String(Date.now() + LATER_HOURS * 3600e3)); } catch { /* private mode */ }
    closeModal();
    let told = false;
    try { told = !(await getSupabase().rpc('note_phone_prompt', { p_event: 'stuck' })).error; } catch { /* offline */ }
    showToast(told
      ? 'Your managers can see the number was not accepted. Ask one of them to sort it out.'
      : 'Carry on for now. Please ask a manager to help you save your number.', 'warning', 7000);
  });
}
