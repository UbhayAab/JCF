// ============================================================
// Patient Navigator: confirm your WhatsApp number (Fixboard #10)
// HopeBot will know a team member by the number they use on WhatsApp (#9:
// papers a team member forwards are filed under the patient whose number
// follows them), so every active member confirms it once, right after
// signing in. "Later" puts it off until the app is next opened, never for
// good. The database is the authority on what counts as a number
// (normalize_team_phone, sql/157); the copy below only formats and
// pre-checks so a typo is caught before the round trip.
// ============================================================

import { getRealProfile, isImpersonating } from '../auth.js';
import { getSupabase } from '../supabase.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';

const LATER_KEY = 'pn_phone_prompt_later';

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
  const prof = getRealProfile();
  if (prof) {
    prof.phone = data.phone;
    prof.phone_confirmed_at = data.phone_confirmed_at;
  }
  return data;
}

function wantsPrompt() {
  if (isImpersonating()) return false;
  const prof = getRealProfile();
  if (!prof || prof.is_active === false || prof.phone_confirmed_at) return false;
  try { if (sessionStorage.getItem(LATER_KEY)) return false; } catch { /* private mode: ask */ }
  return true;
}

function putOff() {
  try { sessionStorage.setItem(LATER_KEY, '1'); } catch { /* private mode */ }
}

/**
 * Called once the app shell is up. Waits for any sheet a page opened on load
 * to close first (one modal at a time, modal.js), then asks.
 */
export function maybeAskForPhone() {
  if (!wantsPrompt()) return;
  if (document.querySelector('.modal-overlay')) {
    window.addEventListener('hashchange', () => setTimeout(maybeAskForPhone, 600), { once: true });
    return;
  }
  openPhonePrompt();
}

export function openPhonePrompt() {
  const prof = getRealProfile();
  const prefill = prof?.phone ? formatTeamPhone(normalizeTeamPhone(prof.phone) || prof.phone) : '';
  const overlay = showModal({
    title: 'Hey team, we need your phone number',
    content: `
      <form id="phone-prompt-form" novalidate>
        <p style="margin:0 0 var(--space-4);line-height:1.55">
          We will be testing HopeBot, our WhatsApp helper, and it will know you by your number.
          Please put your phone number in correctly: the one you use on WhatsApp.
        </p>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" for="phone-prompt-input">Your WhatsApp number</label>
          <input class="form-input" id="phone-prompt-input" type="tel" inputmode="tel" autocomplete="tel"
                 maxlength="20" placeholder="98765 43210" value="${sanitize(prefill)}" />
          <span class="form-hint">The 10 digits of your mobile number. For a number outside India, start with + and the country code.</span>
          <div class="form-error" id="phone-prompt-error" role="alert" style="margin-top:var(--space-2)" hidden></div>
        </div>
      </form>`,
    footer: `
      <button type="button" class="btn btn-ghost" id="phone-prompt-later">Later</button>
      <button type="submit" form="phone-prompt-form" class="btn btn-primary" id="phone-prompt-save">Save my number</button>`,
    onClose: putOff,
  });

  const form = overlay.querySelector('#phone-prompt-form');
  const input = overlay.querySelector('#phone-prompt-input');
  const errorBox = overlay.querySelector('#phone-prompt-error');
  const save = overlay.querySelector('#phone-prompt-save');
  const say = (msg) => { errorBox.textContent = msg; errorBox.hidden = !msg; };

  overlay.querySelector('#phone-prompt-later').addEventListener('click', () => closeModal(putOff));
  input.addEventListener('input', () => say(''));
  setTimeout(() => input.focus(), 250);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!normalizeTeamPhone(raw)) {
      say('That does not look like a mobile number. Type the 10 digits of your number, or + and the country code for a number outside India.');
      input.focus();
      return;
    }
    save.disabled = true;
    save.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const saved = await confirmMyPhone(raw);
      closeModal();
      showToast(`Thank you. HopeBot will know you by ${formatTeamPhone(saved.phone)}.`, 'success');
    } catch (err) {
      say(err.message || 'Could not save the number. Check your connection and try again.');
      save.disabled = false;
      save.textContent = 'Save my number';
    }
  });
}
