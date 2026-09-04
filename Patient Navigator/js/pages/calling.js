// ============================================================
// Patient Navigator: Calling Portal (per-caller worklist)
// Identifies the caller by their login; pulls THEIR assignments
// for today; structured tap-to-select notes. (v2 scheduling)
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { openAssessmentFlow } from '../components/assessmentFlow.js';
import { formatRelativeTime, capitalize } from '../utils/formatters.js';
import { icon } from '../components/icons.js';
import { DIAL_STATUSES, RECEPTIVENESS, REQUIREMENTS, CONDITIONS, giLabel, statusBadge, vulnerabilityBadge, stageGuide, GI_SUBTYPES, dataGaps, CONCERN_REASONS, CALLER_CONCERNS, CONCERN_SEVERITIES, sessionKind, sessionStatus, LEVER_GROUPS } from '../utils/catalog.js';
import { showModal, closeModal } from '../components/modal.js';
import { navigate } from '../router.js';
import { openWhatsappShare, recipientsFromPatient } from '../components/whatsappShare.js';
import { AVATAR_COLORS, avatarColor, initials } from '../utils/avatar.js';

// ---- module state ----
let me = null;                 // current profile
let currentQueueId = null;
let currentPatient = null;
let currentPatientPitches = null;
let currentPatientPriority = null;
let currentPatientSessions = [];   // live 1:1 sessions (invited/agreed/scheduled)
let timerInterval = null;
let timerSeconds = 0;
let timerRunning = false;
let timerStartEpoch = null;     // wall-clock anchor so duration survives a reload
let currentHistory = [];
let currentServices = {};       // patient_services rows by lever, for the in-call toggles
let currentOpenLoops = [];      // "still to ask", read through the call claim
let lastLoggedCall = null;      // { id, name, at } - powers "Fix that log" after submit
let availableToday = true;
const form = blankForm();

// --- active-call persistence: survive a WebView reload, leaving the site to
// take the call, or closing the app entirely. The patient, the running timer
// AND every form field they'd already tapped come back exactly as left.
// localStorage (not sessionStorage): callers leave the site mid-call.
const ACTIVE_KEY = () => `jcf_active_call_${me?.id || 'x'}`;
const ACTIVE_TTL_MS = 20 * 3600 * 1000;   // stale drafts die after ~a day
function saveActive() {
  if (!currentQueueId) return;
  try {
    localStorage.setItem(ACTIVE_KEY(), JSON.stringify({
      queueId: currentQueueId, patient: currentPatient, history: currentHistory || [],
      timerSeconds, timerRunning, timerStartEpoch, form: { ...form }, ts: Date.now(),
    }));
  } catch {}
}
function loadActive() {
  try {
    const r = localStorage.getItem(ACTIVE_KEY()) || sessionStorage.getItem(ACTIVE_KEY());
    if (!r) return null;
    const s = JSON.parse(r);
    if (s.ts && Date.now() - s.ts > ACTIVE_TTL_MS) { clearActive(); return null; }
    return s;
  } catch { return null; }
}
function clearActive() { try { localStorage.removeItem(ACTIVE_KEY()); sessionStorage.removeItem(ACTIVE_KEY()); } catch {} }
// Debounced save for fast-typing text fields: everything else saves instantly.
let saveSoonTimer = null;
function saveActiveSoon() { clearTimeout(saveSoonTimer); saveSoonTimer = setTimeout(saveActive, 400); }
async function restoreActive(s) {
  currentQueueId = s.queueId; currentPatient = s.patient; currentHistory = s.history || [];
  Object.assign(form, blankForm());
  timerSeconds = s.timerSeconds || 0;
  timerRunning = !!s.timerRunning;
  timerStartEpoch = s.timerStartEpoch || null;
  // If the call was timing when the page reloaded (tapping the tel: link
  // reloads the WebView), recover the TRUE elapsed time from the wall clock
  // instead of the stale snapshot. This is what was wiping the duration.
  if (timerRunning && timerStartEpoch) timerSeconds = Math.floor((Date.now() - timerStartEpoch) / 1000);
  await Promise.all([loadPatientPitches(s.patient.patient_id), loadPatientSessions(s.patient.patient_id), loadPatientPriority(s.patient.patient_id)]);
  mountActive(s.patient, currentHistory);
  applySavedForm(s.form);
  if (timerRunning) resumeRunningTimer();
}

// Re-apply a saved draft to the freshly rendered form. Buttons are "clicked"
// programmatically so the existing handlers rebuild both form state and the
// visual selection; text fields are set directly.
function applySavedForm(saved) {
  if (!saved) return;
  const click = (sel) => document.querySelector(sel)?.click();
  if (saved.dialStatus) click(`#seg-outcome .seg-btn[data-status="${saved.dialStatus}"]`);
  if (saved.receptiveness) click(`#recep .recep-btn[data-recep="${saved.receptiveness}"]`);
  if (saved.condition) click(`#seg-condition .seg-btn[data-cond="${saved.condition}"]`);
  (saved.requirements || []).forEach(k => click(`#reqs .chip[data-req="${CSS.escape(k)}"]`));
  (saved.services || []).forEach(k => {
    const label = document.querySelector(`#services .svc[data-svc="${k}"]`);
    const input = label?.querySelector('input');
    if (input && !input.disabled && !input.checked) { input.checked = true; input.dispatchEvent(new Event('change')); }
  });
  ['waLink', 'whatsapp', 'social', 'consent'].forEach(f => {
    if (saved[f] === true || saved[f] === false)
      click(`.yesno[data-yn="${f}"] .yn[data-v="${saved[f] ? 'yes' : 'no'}"]`);
  });
  const setText = (id, field) => {
    const v = saved[field];
    if (!v) return;
    const el = document.getElementById(id); if (el) el.value = v;
    form[field] = v;
  };
  setText('f-customreq', 'customReq');
  setText('f-fb-patient', 'fbPatient');
  setText('f-fb-caregiver', 'fbCaregiver');
  setText('f-notes', 'notes');
  setText('f-strategy', 'strategy');
  if (saved.dateManual && saved.followupDate) {
    form.followupDate = saved.followupDate; form.dateManual = true;
    const el = document.getElementById('f-followup'); if (el) el.value = saved.followupDate;
    const auto = document.getElementById('fu-auto'); if (auto) auto.style.display = 'none';
  }
  updateSubmit();
  saveActive();
}

function blankForm() {
  return { dialStatus: '', receptiveness: '', services: [], whatsapp: null, social: null, waLink: null,
    requirements: [], customReq: '', condition: '', notes: '', followupDate: '', strategy: '',
    fbPatient: '', fbCaregiver: '', consent: null, dateManual: false,
    // Set by recordConsentNow(). MUST live here: Object.assign(form,
    // blankForm()) is how a new call resets the form, and a key that is
    // absent from blankForm is never cleared - so a leftover true would
    // make the NEXT patient's consent silently not get written.
    consentSaved: false };
}

// services the caller can OFFER on this call (pitched_* columns on patients)
const SERVICES = [
  { key: 'therapy',        label: 'Therapy & counselling',   icon: 'heart',       column: 'pitched_therapy_at' },
  { key: 'nutrition',      label: 'Nutrition guidance',      icon: 'leaf',        column: 'pitched_nutrition_at' },
  { key: 'caregiver',      label: 'Caregiver support',       icon: 'users',       column: 'pitched_caregiver_at' },
  { key: 'clinical_trial', label: 'Clinical-trial info',     icon: 'fileText',    column: 'pitched_clinical_trial_at' },
  { key: 'financial_aid',  label: 'Financial-aid guidance',  icon: 'shieldCheck', column: 'pitched_financial_aid_at' },
];
// Didn't pick up (no answer / busy / voicemail) → try again in a week. A
// requested callback also waits a week. Nothing marked comes back the next
// day, ever. Kept in sync with the auto_followup_date trigger (sql/49).
const STATUS_DAYS = { no_answer: 7, busy: 7, voicemail: 7, callback_requested: 7, wrong_number: null };
// days overdue → badge tone + label, for the "catch up" signal
// One household, several numbers: show the dial order (patient first,
// then caregiver 1, then caregiver 2). Once anyone answers, that's the
// family reached: the queue won't resurface them for a week.
const PHONE_LABELS = { patient: 'Patient', caregiver_1: 'Caregiver 1', caregiver_2: 'Caregiver 2', other: 'Other' };

// Every number we hold for this family, in dial order. patients.phone_full is
// the patient's own line and is often blank, while the family's real numbers
// live in patient_phones (sql/48), so the button at the top has to look here too.
function dialablePhones(p) {
  const linked = (Array.isArray(p.phones) ? p.phones : []).filter(ph => ph && ph.phone);
  if (linked.length) return linked;
  // Fallback for a project where sql/48 has not been run: read the flat columns.
  const flat = [];
  if (p.phone_full) flat.push({ phone: p.phone_full, label: 'patient' });
  if (p.caregiver_phone_full) flat.push({ phone: p.caregiver_phone_full, label: 'caregiver_1', contact_name: p.caregiver_name, relationship: p.caregiver_relationship });
  return flat;
}

// The one number the big "Tap to call" button dials.
function primaryPhone(p) {
  const all = dialablePhones(p);
  if (p.phone_full) return { phone: p.phone_full, label: 'patient' };
  return all[0] || null;
}

function renderDialOrder(p) {
  const phones = Array.isArray(p.phones) ? p.phones : [];
  if (phones.length <= 1) return '';
  const LABELS = PHONE_LABELS;
  return `
    <div class="dial-order" style="margin-top:10px;border:1px solid var(--line);border-radius:var(--r-md);padding:11px 13px">
      <div class="info-label" style="margin-bottom:7px">No pickup? Try in this order</div>
      ${phones.map((ph, i) => `
        <a class="cg-call" href="tel:${String(ph.phone).replace(/\s/g, '')}" style="display:flex;align-items:center;gap:9px;margin-top:${i ? 7 : 0}px">
          <span class="badge badge-${i === 0 ? 'primary' : 'neutral'}" style="min-width:24px;justify-content:center">${i + 1}</span>
          <span class="tnum" style="font-weight:600">${ph.phone}</span>
          <span class="faint" style="font-size:12px;color:var(--ink-3)">${LABELS[ph.label] || ph.label}${ph.contact_name && ph.label !== 'patient' ? ' · ' + ph.contact_name : ''}${ph.relationship ? ' (' + ph.relationship + ')' : ''}</span>
        </a>`).join('')}
      <div class="faint" style="font-size:11.5px;color:var(--ink-3);margin-top:9px">One family, one conversation: once anyone answers, log it and stop dialling the other numbers.</div>
    </div>`;
}

function overdueBadge(days) {
  const d = days || 0;
  if (d <= 0) return '';
  const tone = d >= 7 ? 'danger' : 'warn';
  return `<span class="badge badge-${tone}">${icon('clock')}${d}d overdue</span>`;
}

function fmtTimer(s) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }
function badge(tone, label) { return `<span class="badge badge-${tone}"><span class="dot"></span>${label}</span>`; }

export async function renderCalling(container) {
  me = getCurrentProfile();
  container.innerHTML = `<div id="portal-content"></div>`;
  if (!me?.id) { root().innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Not signed in</h4><p>Please sign in again.</p></div>`; return; }
  const saved = loadActive();
  if (saved && saved.queueId && saved.patient) { await restoreActive(saved); return; }
  await mountReady();
}
function root() { return document.getElementById('portal-content'); }

// The Calling Portal is ONE PERSON'S list: get_next_call only ever serves rows
// where call_queue.assigned_to is you. A manager who assigns three patients to a
// mentor, reads that mentor's "3 to go / 8 done" on Team & Queue and then opens
// this page sees an empty queue, which is correct but read as a bug. So the empty
// states now say whose list this is and where the team's calls actually live.
function supervises() {
  const r = getUserRole();
  return r === 'manager' || r === 'admin';
}

// "Nothing was ever assigned to you" and "you finished your list" are different
// facts. Saying "you've worked through your list" to someone who never had one is
// what made this look broken.
function emptyReason(summary) {
  if (summary.done_today > 0) {
    return `You have reached everyone on <strong>your</strong> list today: ${summary.done_today} done. Nothing further is queued for you.`;
  }
  return supervises()
    ? `Nothing is assigned to <strong>you</strong> today. This page only ever serves calls queued to your own name, so a mentor's list will not appear here.`
    : `No one is assigned to you yet today. Ask your manager to build today's list, or check back soon.`;
}

function teamPointerHTML() {
  return `<div style="border:1px solid var(--line);border-radius:var(--r-md);padding:11px 13px;background:var(--surface-2);font:var(--t-xs);color:var(--ink-2);line-height:1.5;text-align:left">
      Looking for calls you assigned to someone else? They sit in that person's queue.
      <button class="btn btn-ghost btn-sm" id="goto-team" style="margin-top:7px">${icon('users')}Open Team &amp; Queue</button>
    </div>`;
}

// ============================================================ Ready
async function mountReady() {
  resetState();
  const sb = getSupabase();
  // current availability for today
  try {
    const { data } = await sb.from('caller_availability').select('available').eq('caller_id', me.id).eq('day', new Date().toISOString().slice(0, 10)).maybeSingle();
    availableToday = data ? data.available : true;
  } catch { availableToday = true; }

  let summary = { pending: 0, follow_ups: 0, new_leads: 0, done_today: 0, overdue: 0, oldest_overdue_days: 0, scheduled_ahead: 0 };
  try { const { data } = await sb.rpc('get_worklist_summary', { p_caller_id: me.id }); if (data) summary = data; } catch {}

  // Today's progress + what's queued for the coming days (list is capped at
  // 15/day; the rest is scheduled forward, so this stays manageable).
  const total = (summary.done_today || 0) + (summary.pending || 0);
  const pct = total ? Math.round((summary.done_today / total) * 100) : 0;
  const overdue = summary.overdue || 0;
  const oldest = summary.oldest_overdue_days || 0;
  const ahead = summary.scheduled_ahead || 0;
  const catchupHTML = `
    <div class="catchup" style="border:1px solid var(--line);border-radius:var(--r-md);padding:12px 14px;background:var(--surface-2);margin:2px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;font:var(--t-xs);color:var(--ink-3)">
        <span>Today's progress</span><span><strong style="color:var(--ink)">${summary.done_today}</strong> done · ${summary.pending} to go</span>
      </div>
      <div style="height:8px;background:var(--surface-3);border-radius:999px;overflow:hidden;margin:7px 0">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--primary-bright),var(--primary));transition:width .4s"></div>
      </div>
      ${overdue > 0
        ? `<div style="display:flex;align-items:center;gap:7px;font:var(--t-xs);color:var(${oldest >= 7 ? '--danger' : '--clay'})"><span style="width:15px;height:15px;display:inline-flex;flex:none">${icon('alertCircle')}</span><span><strong>${overdue} overdue</strong> · oldest ${oldest} day${oldest === 1 ? '' : 's'} behind: reach these first.</span></div>`
        : ahead > 0
          ? `<div style="display:flex;align-items:center;gap:7px;font:var(--t-xs);color:var(--ink-3)"><span style="width:15px;height:15px;display:inline-flex;flex:none">${icon('calendar')}</span><span><strong style="color:var(--ink-2)">${ahead}</strong> more scheduled for the coming days: spread at about 22 a day.</span></div>`
          : `<div style="display:flex;align-items:center;gap:7px;font:var(--t-xs);color:var(--ok)"><span style="width:15px;height:15px;display:inline-flex;flex:none">${icon('checkCircle')}</span>You're all caught up.</div>`}
    </div>`;

  const el = root();
  el.innerHTML = `
    <div class="ready">
      <div style="width:100%;max-width:450px;display:flex;flex-direction:column;gap:var(--s5)">
      <div class="ready-card">
        <div class="ready-ico">${icon('phoneCall')}</div>
        <h2>Ready when you are, ${me.full_name?.split(' ')[0] || 'there'}.</h2>
        <p>${summary.pending > 0
          ? `You have <strong>${summary.pending}</strong> ${summary.pending === 1 ? 'person' : 'people'} to reach today: ${summary.follow_ups} follow-up${summary.follow_ups === 1 ? '' : 's'} and ${summary.new_leads} new. One conversation at a time.`
          : emptyReason(summary)}</p>

        ${summary.pending > 0 ? catchupHTML : ''}
        ${summary.pending === 0 && supervises() ? teamPointerHTML() : ''}

        <div class="avail-row" id="avail-row" style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:4px">
          <span class="badge ${availableToday ? 'badge-ok' : 'badge-warn'}" id="avail-badge"><span class="dot"></span>${availableToday ? 'Calling today' : 'Off today'}</span>
          <button class="btn btn-ghost btn-sm" id="avail-toggle">${availableToday ? 'Mark me off today' : "I'm calling today"}</button>
        </div>

        <button class="btn btn-primary btn-lg btn-block" id="start" ${summary.pending > 0 ? '' : 'disabled'} style="margin-top:6px">${icon('phoneCall')}Start calling</button>
        <div class="ready-stats">
          <div data-goto-list style="cursor:pointer" title="See who's on today's list"><div class="rs-num" id="rs-follow">${summary.follow_ups}</div><div class="rs-lbl">Follow-ups</div></div>
          <div class="rs-div"></div>
          <div data-goto-list style="cursor:pointer" title="See who's on today's list"><div class="rs-num" id="rs-new">${summary.new_leads}</div><div class="rs-lbl">New leads</div></div>
          <div class="rs-div"></div>
          <div><div class="rs-num">${summary.done_today}</div><div class="rs-lbl">Done today</div></div>
        </div>
      </div>
      <div class="card card-flush" id="today-list">
        <div class="card-head"><h3>Today's list</h3><span class="badge badge-neutral" id="tl-count">…</span></div>
        <div id="tl-body"><div style="padding:var(--s4)">${Array(3).fill('<div class="sk skeleton-row"></div>').join('')}</div></div>
      </div>
      </div>
    </div>`;

  document.getElementById('start')?.addEventListener('click', getNextCall);
  document.getElementById('goto-team')?.addEventListener('click', () => navigate('team'));
  document.getElementById('avail-toggle')?.addEventListener('click', toggleAvailability);
  el.querySelectorAll('[data-goto-list]').forEach(t => t.addEventListener('click', scrollToTodayList));
  loadTodayList();
}

// ---- Today's list: the SAME rows get_next_call draws from (one shared
// definition, get_my_worklist), so what the mentor SEES is what gets served.
// Servable rows are tappable; resting ones stay visible, greyed, with the
// date they resurface. No one silently vanishes.
async function loadTodayList() {
  const card = document.getElementById('today-list');
  const body = document.getElementById('tl-body');
  const countEl = document.getElementById('tl-count');
  if (!card || !body) return;
  try {
    const { data, error } = await getSupabase().rpc('get_my_worklist');
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) { card.style.display = 'none'; return; }
    const servable = rows.filter(r => r.servable).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    const resting = rows.filter(r => !r.servable && r.resting && !r.no_number)
      .sort((a, b) => String(a.resting_until || '').localeCompare(String(b.resting_until || '')));
    // Un-callable rows (sql/72): nothing to dial, so they never reach the top
    // of the queue any more. They stay listed, because the number is the work.
    const noNumber = rows.filter(r => r.no_number);
    const later = rows.length - servable.length - resting.length - noNumber.length;
    if (countEl) countEl.textContent = servable.length ? `${servable.length} to call` : 'none to call';
    body.innerHTML = `
      <div class="due-list">
        ${servable.map(r => worklistRowHTML(r, true)).join('')}
        ${resting.map(r => worklistRowHTML(r, false)).join('')}
        ${noNumber.map(r => worklistRowHTML(r, false)).join('')}
      </div>
      ${noNumber.length ? `<div class="due-meta" style="padding:0 var(--s5) var(--s4);color:var(--ink-3)">
        ${noNumber.length} ${noNumber.length === 1 ? 'person has' : 'people have'} no phone number on file, so they are held out of the call order instead of blocking it. Open the profile to add a number and they come back into the list.</div>` : ''}
      ${later > 0 ? `<div class="due-meta" style="padding:0 var(--s5) var(--s4);color:var(--ink-3)">+ ${later} more scheduled for the coming days.</div>` : ''}`;
    body.querySelectorAll('[data-qid]').forEach(row => row.addEventListener('click', () => startFromList(row.dataset.qid, row)));
    body.querySelectorAll('[data-pid]').forEach(row => row.addEventListener('click', () => navigate('patients/' + row.dataset.pid)));
  } catch (err) {
    // RPC not deployed yet or a network blip: the Start button still works.
    console.warn('Worklist error:', err);
    card.style.display = 'none';
  }
}

function worklistRowHTML(r, servable) {
  const name = r.full_name || r.patient_code || 'Patient';
  const srcBadge = r.source === 'followup' ? badge('primary', 'Follow-up') : badge('gold', 'New');
  const meta = servable
    ? (r.last_call_date ? `Last call ${formatRelativeTime(r.last_call_date)}` : 'First conversation')
    : r.no_number
      ? 'No phone number on file: add one to bring them back into the list'
      : `Resting: resurfaces ${fmtDayIN(r.resting_until)}`;
  // An un-callable row opens the profile instead of the call flow: the only
  // useful action on it is filling in the number.
  const attrs = servable
    ? `data-qid="${r.queue_id}" style="cursor:pointer" title="Call ${name} now"`
    : r.no_number
      ? `data-pid="${r.patient_id}" style="cursor:pointer;opacity:.75" title="Open ${name} and add a number"`
      : 'style="opacity:.55"';
  return `
    <div class="due-row${servable || r.no_number ? ' clickable' : ''}" ${attrs}>
      <span class="avatar avatar-sm" style="background:${avatarColor(name)}">${initials(name)}</span>
      <div class="grow" style="flex:1;min-width:0">
        <div class="due-name">${name}</div>
        <div class="due-meta">${meta}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        ${r.no_number ? badge('warn', 'No number') : srcBadge}${servable ? overdueBadge(r.overdue_days) : ''}
      </div>
    </div>`;
}
function fmtDayIN(d) { return d ? new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : 'soon'; }

function scrollToTodayList() {
  const card = document.getElementById('today-list');
  if (!card || card.style.display === 'none') { showToast('Your list is empty right now', 'info'); return; }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.style.transition = 'box-shadow .35s ease';
  card.style.boxShadow = '0 0 0 3px var(--primary-bright)';
  setTimeout(() => { card.style.boxShadow = ''; }, 1300);
}

// Tap a specific person on the list: same claim + same active-call flow as
// "Start calling", just this patient instead of rank #1.
async function startFromList(queueId, rowEl) {
  if (!queueId || currentQueueId) return;
  if (rowEl) { rowEl.style.pointerEvents = 'none'; rowEl.style.opacity = '.6'; }
  try {
    const { data, error } = await getSupabase().rpc('get_call_by_queue_id', { p_queue_id: queueId });
    if (error) throw error;
    if (!data || data.found === false) { showToast('Could not open this call, refreshing your list', 'warning'); await mountReady(); return; }
    await startCallSession(data);
  } catch (err) {
    // The RPC raises human messages ('resting until…' / 'already completed').
    showToast(err.message || 'Could not open this call', 'warning');
    await mountReady();
  }
}

async function toggleAvailability() {
  const sb = getSupabase();
  const next = !availableToday;
  try {
    await sb.rpc('mark_availability', { p_available: next });
    availableToday = next;
    showToast(next ? "You're marked as calling today" : "You're marked off today. Your patients will be covered", next ? 'success' : 'info');
    const badge = document.getElementById('avail-badge');
    const btn = document.getElementById('avail-toggle');
    if (badge) { badge.className = `badge ${next ? 'badge-ok' : 'badge-warn'}`; badge.innerHTML = `<span class="dot"></span>${next ? 'Calling today' : 'Off today'}`; }
    if (btn) btn.textContent = next ? 'Mark me off today' : "I'm calling today";
  } catch (e) { showToast('Could not update availability: ' + e.message, 'error'); }
}

// ============================================================ Get next
// justSkippedId: the row a Skip just sank. If it comes straight back, the
// caller is on the last one and needs to be told that, not shown the same
// screen twice with no explanation.
async function getNextCall(justSkippedId = null) {
  const sb = getSupabase();
  const btn = document.getElementById('start');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:20px;height:20px;border-width:2.5px"></span>Finding the next person…'; }
  try {
    const { data, error } = await sb.rpc('get_next_call', { p_team_member_id: me.id });
    if (error) throw error;
    if (!data || !data.found) { await mountQueueEmpty(); return; }
    if (justSkippedId && data.queue_id === justSkippedId) {
      showToast(`${(data.full_name || 'They').split(' ')[0]} is the only person left on your list today, so they come straight back.`, 'info', 9000);
    }
    await startCallSession(data);
  } catch (err) {
    showToast('Something went wrong: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('phoneCall')}Start calling`; }
  }
}

// One entry into the active-call view: get_next_call and the tappable
// Today's list both land here with the same claimed-queue JSON.
async function startCallSession(data) {
  currentQueueId = data.queue_id;
  currentPatient = data;
  Object.assign(form, blankForm());
  timerSeconds = 0; timerRunning = false; timerStartEpoch = null;
  clearInterval(timerInterval); timerInterval = null;
  await Promise.all([loadPatientPitches(data.patient_id), loadPatientSessions(data.patient_id), loadPatientPriority(data.patient_id),
                     loadPatientServices(data.patient_id), loadOpenLoopsForCall(data.patient_id)]);
  currentHistory = await loadPatientHistory(data.patient_id);
  saveActive();
  mountActive(data, currentHistory);
}

// ---- Support levers and open loops, for the call itself ----
// Reported: interns had to go back to the patient section after the call to
// tick what they had given, and the "still to ask" list was not visible while
// logging. Both used to be patient-page-only, and neither could simply be
// moved: patient_services goes through a policy whose inner EXISTS runs under
// the caller's own patients RLS, and v_open_loops is security_invoker. A
// coverage caller or an unassigned new lead - exactly the cases the portal
// exists for - would have got an empty list and a toggle that failed to save.
// So both read through the call claim instead. sql/116.
async function loadPatientServices(patientId) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.from('patient_services')
      .select('lever, done, amount, sessions, outcome, detail, updated_at')
      .eq('patient_id', patientId);
    if (error) throw error;
    currentServices = Object.fromEntries((data || []).map(r => [r.lever, r]));
  } catch { currentServices = {}; }
}

async function loadOpenLoopsForCall(patientId) {
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc('get_open_loops_for_call', { p_patient_id: patientId });
    if (error) throw error;
    currentOpenLoops = data || [];
  } catch { currentOpenLoops = []; }   // an older deploy just shows nothing
}

async function loadPatientPitches(patientId) {
  const sb = getSupabase();
  try {
    const cols = SERVICES.map(s => s.column).join(',');
    // maybeSingle: callers can't always SELECT unassigned new leads (RLS).
    // Zero rows is normal there, not an error.
    const { data } = await sb.from('patients').select(cols).eq('id', patientId).maybeSingle();
    currentPatientPitches = data || {};
  } catch { currentPatientPitches = {}; }
}
// Live 1:1 sessions for the invitation moment + the "session coming up"
// banner (care_sessions is team-readable, so this works even for patients
// whose row RLS hides from this mentor).
// The one line of context a mentor should have BEFORE she dials: which band
// this family is in and what put them there. Same row the patients list sorts
// by (v_patient_priority, sql/80), so the queue, the list and this card cannot
// tell her three different stories about the same person.
async function loadPatientPriority(patientId) {
  const sb = getSupabase();
  try {
    const { data } = await sb.from('v_patient_priority')
      .select('band, reason, concern_sev, overdue_days, fields_known, fields_total, calls_held')
      .eq('patient_id', patientId)
      .maybeSingle();
    currentPatientPriority = data || null;
  } catch { currentPatientPriority = null; }
}

async function loadPatientSessions(patientId) {
  const sb = getSupabase();
  try {
    const { data } = await sb.from('care_sessions')
      .select('id, kind, status, scheduled_at, assigned_to')
      .eq('patient_id', patientId)
      .in('status', ['invited', 'agreed', 'scheduled'])
      .order('created_at', { ascending: false });
    currentPatientSessions = data || [];
  } catch { currentPatientSessions = []; }
}
async function loadPatientHistory(patientId) {
  const sb = getSupabase();
  // SECURITY DEFINER RPC: the caller on this queue entry sees the FULL
  // history, everyone's notes, not just their own (plain RLS hides those).
  try {
    const { data, error } = await sb.rpc('get_patient_call_history', { p_patient_id: patientId });
    if (error) throw error;
    return data || [];
  } catch {
    try {
      const { data } = await sb.from('call_logs').select('*').eq('patient_id', patientId).order('call_date', { ascending: false }).limit(20);
      return (data || []).map(h => ({ ...h, caller_name: h.contacted_by_name, is_mine: false }));
    } catch { return []; }
  }
}

// ---- "Fix that log" ----
// Reported: "On the calling portal once you enter a log call you cannot go
// back, so maybe adding that feature might help."
//
// Submit moves to the next patient 400 ms later, which is right - the whole
// portal is built to keep someone dialling. What was missing was any way back
// to the thing just written. This is a two-minute window on the next screen,
// opening the correction form that already exists (openEditCall, backed by
// correct_call_log in sql/68), rather than a new edit path that could disagree
// with it.
const UNDO_WINDOW_MS = 120000;

function undoBarHTML() {
  if (!lastLoggedCall || Date.now() - lastLoggedCall.at > UNDO_WINDOW_MS) return '';
  return `
    <div class="card" id="undo-bar" style="padding:11px 15px;margin-bottom:var(--s4);display:flex;align-items:center;gap:11px;flex-wrap:wrap;border-left:4px solid var(--ok)">
      <span class="stat-ico ok" style="width:30px;height:30px;border-radius:8px">${icon('checkCircle')}</span>
      <div style="flex:1;min-width:180px">
        <div class="info-value">Logged for ${sanitizeText(lastLoggedCall.name)}</div>
        <div class="due-meta">Got something wrong? You can still fix it.</div>
      </div>
      <button class="btn btn-secondary btn-sm" id="undo-open">${icon('edit')}Fix that log</button>
      <button class="btn btn-ghost btn-sm" id="undo-dismiss">Dismiss</button>
    </div>`;
}

function wireUndoBar() {
  const bar = document.getElementById('undo-bar');
  if (!bar) return;
  bar.querySelector('#undo-dismiss')?.addEventListener('click', () => { lastLoggedCall = null; bar.remove(); });
  bar.querySelector('#undo-open')?.addEventListener('click', async () => {
    const btn = bar.querySelector('#undo-open');
    btn.disabled = true;
    try {
      // Read the row back with the joins openEditCall expects. It is a fresh
      // read rather than the insert's return value so a correction is always
      // made against what is actually stored.
      const { data, error } = await getSupabase().from('call_logs')
        .select('*, patients(id, full_name, assigned_to), profiles:caller_id(full_name)')
        .eq('id', lastLoggedCall.id).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('that log could not be found any more');
      const { openEditCall } = await import('./calls.js');
      openEditCall(data);
    } catch (e) {
      showToast('Could not open that log: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  });
}

// ============================================================ Active view
function mountActive(p, history) {
  currentHistory = history || [];
  const el = root(); if (!el) return;
  const name = p.full_name || p.patient_code || 'Patient';
  const attemptTone = p.attempt >= 3 ? 'danger' : p.attempt === 2 ? 'warn' : 'info';
  const location = [p.city, p.state].filter(Boolean).join(', ') || 'N/A';
  const srcBadge = p.source === 'followup' ? badge('primary', 'Follow-up') : badge('gold', 'New lead');
  const info = [
    { label: 'Age / Gender', value: `${p.age || 'N/A'} · ${capitalize(p.gender || 'N/A')}` },
    { label: 'Location', value: location },
    { label: 'Cancer', value: giLabel(p.gi_subtype) || p.cancer_type || 'Not reported' },
    { label: 'Stage', value: p.tnm_stage || capitalize(p.cancer_stage || 'N/A') },
    { label: 'Treatment', value: p.current_treatment || 'N/A' },
    { label: 'Hospital', value: p.treating_hospital || 'N/A' },
    { label: 'Trajectory', value: capitalize(p.trajectory || 'N/A') },
    { label: 'ECOG', value: p.ecog_status != null ? String(p.ecog_status) + ' / 4' : 'N/A' },
    { label: 'Paying via', value: p.payment_method || capitalize(p.insurance_status || 'N/A') },
    { label: 'Language', value: p.primary_language || 'N/A' },
  ];
  // The number the big button dials. It used to read patients.phone_full only,
  // so a family whose numbers are all caregiver lines saw "No number on file"
  // with those very numbers listed underneath, and the button's href="#" threw
  // the hash router onto the login screen.
  const dialPrimary = primaryPhone(p);
  const dialWho = dialPrimary && dialPrimary.label && dialPrimary.label !== 'patient'
    ? `${PHONE_LABELS[dialPrimary.label] || 'Contact'}${dialPrimary.contact_name ? ' · ' + dialPrimary.contact_name : ''}`
    : '';
  el.innerHTML = `
    ${undoBarHTML()}
    <div class="portal-grid">
      <div class="col-left">
        <div class="card pcard">
          <div class="pcard-head">
            <span class="avatar avatar-lg" style="background:${avatarColor(name)}">${initials(name)}</span>
            <div class="grow" style="flex:1;min-width:0">
              <h2 class="pcard-name">${name}</h2>
              <div class="row gap2" style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
                <span class="faint tnum" style="font-size:12.5px;color:var(--ink-3)">${p.patient_code || ''}</span>
                ${srcBadge}${overdueBadge(p.days_overdue)}<span class="badge badge-${attemptTone}">Attempt ${p.attempt || 1}</span>
                ${p.patient_status ? statusBadge(p.patient_status) : ''}${vulnerabilityBadge(p.vulnerability_score)}
                ${consentBadge(p)}
              </div>
            </div>
          </div>
          ${dialPrimary ? `
          <a class="callbtn" href="tel:${String(dialPrimary.phone).replace(/\s/g, '')}">
            <span class="cb-ico">${icon('phone')}</span>
            <div class="grow" style="flex:1"><div class="cb-label">Tap to call${dialWho ? ' · ' + dialWho : ''}</div><div class="cb-num tnum">${dialPrimary.phone}</div></div>
            ${icon('chevronRight')}
          </a>
          <button class="btn btn-secondary" id="copy-num" data-num="${String(dialPrimary.phone).replace(/\s/g, '')}" style="width:100%;justify-content:center;gap:8px;margin-top:8px">${icon('copy')}Copy number</button>`
          : `
          <div class="strategy" style="margin-bottom:0">
            <div class="strategy-head"><span class="strategy-ico">${icon('phone')}</span>
              <div><div class="strategy-title">No number on file</div></div>
            </div>
            <p class="strategy-body">There is nothing to dial for this family yet. Add a number on their profile and they come back into the call order. Your notes here are kept while you go.</p>
          </div>
          <button class="btn btn-secondary" id="open-profile-num" style="width:100%;justify-content:center;gap:8px;margin-top:8px">${icon('user')}Open profile to add a number</button>`}
          <!-- Was "Send resources on WhatsApp". Renamed because interns reported
               they could not get at financial and accommodation help quickly:
               match_resources() was already running behind this button, but a
               button that says "send" does not read as somewhere to LOOK
               something up while you are talking. -->
          <button class="btn btn-gold" id="wa-share-btn" style="width:100%;justify-content:center;gap:8px;margin-top:8px">${icon('handHeart')}Find help for them · money, stay, food</button>
          <button class="btn btn-secondary" id="open-shelf-btn" style="width:100%;justify-content:center;gap:8px;margin-top:8px">${icon('search')}Open the full resource shelf</button>
          ${renderDialOrder(p)}
          ${renderPriorityBanner()}
          ${renderStageGuide(p)}
          ${p.followup_strategy_notes ? `
          <div class="strategy">
            <div class="strategy-head"><span class="strategy-ico">${icon('handHeart')}</span>
              <div><div class="strategy-title">A note from the last call</div>
              ${p.receptiveness_bucket ? `<div class="faint" style="font-size:12.5px;color:var(--ink-3)">Last spoke · they were <strong style="color:var(--ink-2)">${capitalize(p.receptiveness_bucket)}</strong></div>` : ''}</div>
            </div>
            <p class="strategy-body">${p.followup_strategy_notes}</p>
          </div>` : ''}
          ${renderSessionBanner()}
          <div class="info-grid">${info.map(i => `<div class="info-cell"><div class="info-label">${i.label}</div><div class="info-value">${i.value}</div></div>`).join('')}</div>
          ${p.caregiver_name ? `
          <div class="caregiver">
            <div class="row gap2" style="display:flex;align-items:center;gap:8px"><span class="cg-ico">${icon('users')}</span>
              <div><div class="info-label">Caregiver</div><div class="info-value">${p.caregiver_name}${p.caregiver_relationship ? ' · ' + p.caregiver_relationship : ''}</div></div></div>
            ${p.caregiver_phone_full && !(Array.isArray(p.phones) && p.phones.length > 1) ? `<a class="cg-call" href="tel:${p.caregiver_phone_full.replace(/\s/g, '')}">${icon('phone')}<span class="tnum">${p.caregiver_phone_full}</span></a>` : ''}
          </div>` : ''}
          <div class="timer">
            <div class="timer-display"><span class="timer-dot" id="t-dot"></span><span class="timer-time tnum" id="t-time">${fmtTimer(timerSeconds)}</span></div>
            <button class="btn btn-primary" id="t-toggle">${icon('play')}Start call</button>
          </div>
          <!-- The timer can only start from inside the portal (tapping a number,
               copying one, or Start call). Anyone dialling on a separate handset
               while the portal is open on a laptop had no way to record how long
               they talked, so the minutes were being lost or corrected later. -->
          <div class="timer-manual" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">
            <span class="info-label" style="color:var(--ink-3)">Dialled from another phone?</span>
            <label style="display:flex;align-items:center;gap:6px">
              <input class="input tnum" id="t-mins" type="number" min="0" max="600" step="1" placeholder="min"
                     value="${timerSeconds ? Math.ceil(timerSeconds / 60) : ''}" style="width:78px" />
              <span class="info-label" style="color:var(--ink-3)">minutes talked</span>
            </label>
          </div>
          ${p.legacy_notes ? `
          <details class="history" style="border-top:1px solid var(--line);padding-top:var(--s4)">
            <summary class="info-label" style="cursor:pointer;margin-bottom:6px">Notes from intake</summary>
            <div class="hist-note" style="margin-top:6px">${p.legacy_notes}</div>
          </details>` : ''}
          ${renderFullHistory(history)}
        </div>
        ${renderOpenLoopsPanel(p)}
        ${renderGapsPanel(p)}
      </div>
      <div class="col-right">${renderLogForm(p)}</div>
    </div>`;
  wireActive(p);
  wireGapsPanel(p);
  wireLeversPanel(p);
  wireUndoBar();
}

// Every previous conversation (everyone's notes, newest first) so the
// caller has full context before they dial.
function renderFullHistory(history) {
  if (!history.length) return `<div class="history"><div class="info-label">First contact: no calls yet. You're opening this relationship.</div></div>`;
  return `
    <div class="history">
      <div class="info-label" style="margin-bottom:8px">The story so far · ${history.length} call${history.length === 1 ? '' : 's'}</div>
      <div style="max-height:340px;overflow-y:auto;padding-right:6px">
        ${history.map(h => {
          const ds = DIAL_STATUSES.find(d => d.key === h.dial_status) || { label: capitalize(h.dial_status || 'N/A'), tone: 'neutral' };
          const reqs = h.structured?.requirements || [];
          const cond = CONDITIONS.find(c => c.key === h.patient_condition);
          return `<div class="hist-row" style="flex-direction:column;gap:5px;align-items:stretch">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${badge(ds.tone, ds.label)}
              ${h.receptiveness_bucket ? `<span class="badge badge-primary">${capitalize(h.receptiveness_bucket)}</span>` : ''}
              ${cond ? `<span class="badge badge-${cond.tone === 'ok' ? 'ok' : cond.tone === 'danger' ? 'danger' : cond.tone === 'warn' ? 'warn' : 'neutral'}">${cond.label}</span>` : ''}
              <span class="hist-meta">${h.is_mine ? 'You' : capitalize((h.caller_name || 'N/A').toLowerCase())} · ${formatRelativeTime(h.call_date)}${h.call_duration_mins ? ` · ${h.call_duration_mins} min` : ''}</span>
            </div>
            ${h.caller_notes ? `<div class="hist-note">${h.caller_notes}</div>` : ''}
            ${h.feedback_patient ? `<div class="hist-note" style="font-style:italic">“${h.feedback_patient}” · patient</div>` : ''}
            ${h.followup_strategy_notes ? `<div class="hist-note" style="color:var(--clay)">↪ for the next caregiver mentor: ${h.followup_strategy_notes}</div>` : ''}
            ${reqs.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap">${reqs.map(r => `<span class="badge badge-gold" style="font-size:11px;padding:2px 8px">${r}</span>`).join('')}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ---- Consent, visible before anything else ----
// Reported: "the consent box is in the completed form and people have to open
// the call logs and then go click on the consent ... should be the first thing
// that they check". Until now the ONLY read of p.consent_given anywhere in the
// portal was the one that HID the consent block once it was given, so a caller
// could not tell whether a family had consented at all.
function consentBadge(p) {
  return p.consent_given
    ? `<span class="badge badge-ok" title="Consent on file. Details from this call can be saved.">Consent given</span>`
    : `<span class="badge badge-warn" title="No consent on file yet. Ask first: nothing about them can be saved until they say yes.">Consent needed</span>`;
}

// ---- "Still to ask": offers that are waiting on an answer ----
// The patient page has had this since sql/85 (loadOpenLoops). It was never in
// the portal, which is the one place it is actually useful, because it is a
// list of sentences to say out loud.
function renderOpenLoopsPanel(p) {
  const loops = currentOpenLoops || [];
  if (!loops.length) return '';
  const first = (p.full_name || '').split(' ')[0] || 'them';
  return `
    <div class="card card-flush" id="loops-panel" style="margin-top:var(--s4)">
      <div class="card-head" style="padding:14px 18px">
        <h3 style="font-size:15.5px;display:flex;align-items:center;gap:8px"><span style="width:17px;height:17px;display:inline-flex;flex:none">${icon('clock')}</span>Still to ask ${sanitizeText(first)}</h3>
        <span class="badge badge-warn">${loops.length} waiting</span>
      </div>
      <div style="padding:6px 12px 12px;max-height:300px;overflow-y:auto">
        ${loops.map(l => `
          <div class="lever-row" style="align-items:flex-start">
            <span class="stat-ico warn" style="width:30px;height:30px;border-radius:8px;flex:none">${icon('clock')}</span>
            <div style="flex:1;min-width:0">
              <div class="lever-label">${sanitizeText(l.question_en || '')}</div>
              ${l.question_hi ? `<div class="due-meta" style="margin-top:2px">${sanitizeText(l.question_hi)}</div>` : ''}
              <div class="due-meta" style="margin-top:3px">Sent ${l.days_since_offer} day${l.days_since_offer === 1 ? '' : 's'} ago${l.offered_by_name ? ' by ' + sanitizeText(l.offered_by_name) : ''}. Ask today, then tick it under Support given.</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---- Support levers, on the call ----
// Reported: "Support toggles were reported to be inconsistently available
// during live calls. At times, interns have to return to the patient section
// after the call to update support."
//
// Saves immediately through set_service_lever (sql/116), the same way the gap
// panel saves, rather than waiting for Submit. A lever is a fact about what we
// gave a family; it should not be lost because a log was abandoned. It also
// keeps this panel clear of the draft-restore machinery.
function renderLeversPanel(p) {
  const svc = currentServices || {};
  const done = Object.values(svc).filter(x => x.done).length;
  return `
    <div class="followup" id="levers-panel" style="display:block">
      <div class="fu-head" style="justify-content:space-between">
        <span style="display:flex;align-items:center;gap:8px">${icon('handHeart')}<span>Support given</span></span>
        <span class="badge badge-${done ? 'ok' : 'neutral'}" id="levers-count">${done} on</span>
      </div>
      <div style="margin-top:8px">
        <p class="due-meta" style="margin:2px 0 8px">Tick these as you go. They save on their own, straight away, so there is nothing to come back for after the call.</p>
        ${LEVER_GROUPS.map(g => `
          <div class="lever-group">
            <div class="lever-group-title">${g.group}</div>
            ${g.levers.map(l => portalLeverRow(l, svc[l.key])).join('')}
          </div>`).join('')}
      </div>
    </div>`;
}

function portalLeverRow(lever, svc) {
  const on = !!svc?.done;
  const hide = on ? '' : 'style="display:none"';
  let extra = '';
  if (lever.field === 'amount') {
    extra = `<div class="lever-extra" ${hide}><input class="input" type="number" min="0" data-extra="amount" placeholder="INR" value="${svc?.amount ?? ''}" title="${lever.fieldLabel}" style="width:104px" /></div>`;
  } else if (lever.field === 'sessions') {
    extra = `<div class="lever-extra" ${hide}><input class="input" type="number" min="0" max="200" data-extra="sessions" placeholder="#" value="${svc?.sessions ?? ''}" title="${lever.fieldLabel}" style="width:84px" /></div>`;
  } else if (lever.field === 'outcome') {
    extra = `<div class="lever-extra" ${hide}><select class="select" data-extra="outcome" title="${lever.fieldLabel}">
      <option value="">${lever.fieldLabel}...</option>
      ${lever.options.map(o => `<option value="${o.key}" ${svc?.outcome === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}</select></div>`;
  } else if (lever.field === 'detail') {
    extra = `<div class="lever-extra" ${hide}><input class="input" data-extra="detail" placeholder="${lever.fieldLabel}..." value="${sanitizeText(svc?.detail || '')}" style="width:190px" /></div>`;
  }
  return `
    <div class="lever-row ${on ? 'on' : ''}" data-lever="${lever.key}">
      <label class="switch"><input type="checkbox" data-toggle ${on ? 'checked' : ''} /><span class="knob"></span></label>
      <span class="lever-label">${lever.label}</span>
      ${extra}
    </div>`;
}

function wireLeversPanel(p) {
  const panel = document.getElementById('levers-panel');
  if (!panel) return;
  const syncCount = () => {
    const n = Object.values(currentServices || {}).filter(x => x.done).length;
    const badge = document.getElementById('levers-count');
    if (badge) { badge.textContent = `${n} on`; badge.className = `badge badge-${n ? 'ok' : 'neutral'}`; }
  };
  panel.querySelectorAll('.lever-row[data-lever]').forEach(row => {
    const lever = row.dataset.lever;
    const save = async () => {
      const toggle = row.querySelector('[data-toggle]');
      const num = (sel) => { const v = row.querySelector(sel)?.value; return v === '' || v == null ? null : Number(v); };
      const txt = (sel) => row.querySelector(sel)?.value?.trim() || null;
      toggle.disabled = true;
      try {
        const { error } = await getSupabase().rpc('set_service_lever', {
          p_patient_id: p.patient_id,
          p_lever: lever,
          p_done: toggle.checked,
          p_amount: num('[data-extra="amount"]'),
          p_sessions: num('[data-extra="sessions"]'),
          p_outcome: txt('[data-extra="outcome"]'),
          p_detail: txt('[data-extra="detail"]'),
        });
        if (error) throw error;
        currentServices[lever] = { ...(currentServices[lever] || {}), lever, done: toggle.checked };
        syncCount();
      } catch (e) {
        // Put the switch back. A toggle that looks saved and is not is the
        // exact failure this panel exists to remove.
        toggle.checked = !toggle.checked;
        row.classList.toggle('on', toggle.checked);
        const extra = row.querySelector('.lever-extra');
        if (extra) extra.style.display = toggle.checked ? '' : 'none';
        showToast('Could not save that: ' + e.message, 'error');
      } finally { toggle.disabled = false; }
    };
    row.querySelector('[data-toggle]').addEventListener('change', (e) => {
      const on = e.target.checked;
      row.classList.toggle('on', on);
      const extra = row.querySelector('.lever-extra');
      if (extra) extra.style.display = on ? '' : 'none';
      save();
    });
    row.querySelectorAll('.lever-extra .input, .lever-extra .select').forEach(inp => inp.addEventListener('change', save));
  });
}

// ---- "Ask today": the data-gap radar for this patient ----
function renderGapsPanel(p) {
  const callNum = callNumberOf(p);
  const gaps = dataGaps(p, callNum);
  if (!p.consent_given) {
    return `<div class="card" id="gaps-panel" style="padding:14px 18px;display:flex;align-items:flex-start;gap:10px">
      <span class="stat-ico warn">${icon('shieldCheck')}</span>
      <div><div class="info-value">Ask for consent first</div>
      <div class="due-meta">Nothing about ${sanitizeText((p.full_name || '').split(' ')[0] || 'them')} can be saved until they agree. The consent question is at the top of the form on the right; tick it and these questions open up.</div></div>
    </div>`;
  }
  if (!gaps.length) {
    return `<div class="card" style="padding:14px 18px;display:flex;align-items:center;gap:10px">
      <span class="stat-ico ok">${icon('checkCircle')}</span>
      <div><div class="info-value">Record complete</div><div class="due-meta">Nothing missing for ${(p.full_name || '').split(' ')[0]}: just be there for them.</div></div>
    </div>`;
  }
  const unlocked = gaps.filter(g => g.unlocked);
  if (callNum === 1) {
    return `<div class="card" style="padding:14px 18px;display:flex;align-items:center;gap:10px">
      <span class="stat-ico warn">${icon('search')}</span>
      <div><div class="info-value">${gaps.length} detail${gaps.length === 1 ? '' : 's'} missing, but not today</div>
      <div class="due-meta">First call is for trust. All the asks appear here from the next call.</div></div>
    </div>`;
  }
  // From call 2 EVERY missing question is visible (gentler asks listed first).
  // The caller judges what flows; nothing is hidden behind later calls.
  return `
    <div class="card card-flush" id="gaps-panel">
      <div class="card-head" style="padding:14px 18px">
        <h3 style="font-size:15.5px;display:flex;align-items:center;gap:8px"><span style="width:17px;height:17px;display:inline-flex;flex:none">${icon('search')}</span>Ask today, if it flows</h3>
        <span class="badge badge-warn">${unlocked.length} missing</span>
      </div>
      <div style="padding:6px 12px 12px;max-height:420px;overflow-y:auto">
        ${unlocked.map(g => `
          <div class="lever-row" data-gap="${g.key}" style="cursor:pointer">
            <span class="stat-ico warn" style="width:30px;height:30px;border-radius:8px">${icon('plus')}</span>
            <div style="flex:1;min-width:160px">
              <div class="lever-label">${g.label}</div>
              <div class="due-meta" style="font-style:italic">${g.ask}</div>
            </div>
            <div class="lever-extra" data-gap-input style="display:none"></div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---- Consent, written the moment it is given ----
// Not at Submit. Consent is a legal record with a 3-year retention clock hung
// off consent_date; it belongs in the database when the family says yes, not
// when a write-up happens to be finished. It is also what unlocks the rest of
// the screen, because sql/116 refuses clinical writes without it - so the gap
// panel is re-rendered here rather than after Submit.
async function recordConsentNow(p) {
  if (!p || p.consent_given) return;
  const note = document.getElementById('consent-saved');
  try {
    const { error } = await getSupabase().rpc('update_patient_from_call', {
      p_patient_id: p.patient_id,
      p_fields: {
        consent_given: true,
        consent_date: new Date().toISOString(),
        consent_method: 'verbal_during_call',
      },
    });
    if (error) throw error;
    p.consent_given = true;
    if (currentPatient) currentPatient.consent_given = true;
    form.consentSaved = true;
    if (note) { note.style.display = ''; note.textContent = 'Consent recorded. You can note their details now.'; }
    // Open the questions that were locked a second ago.
    const panel = document.getElementById('gaps-panel');
    if (panel) { panel.outerHTML = renderGapsPanel(p); wireGapsPanel(p); }
    const badge = document.querySelector('.pcard-head .badge-warn[title^="No consent"]');
    if (badge) badge.outerHTML = consentBadge(p);
  } catch (e) {
    showToast('Could not record consent: ' + e.message, 'error');
  }
}

function wireGapsPanel(p) {
  const panel = document.getElementById('gaps-panel');
  if (!panel) return;
  const callNum = callNumberOf(p);
  panel.querySelectorAll('[data-gap]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-gap-input]')) return; // typing, not toggling
      const gap = dataGaps(p, callNum).find(g => g.key === row.dataset.gap);
      if (!gap) return;
      const mount = row.querySelector('[data-gap-input]');
      const open = mount.style.display !== 'none';
      // close all others
      panel.querySelectorAll('[data-gap-input]').forEach(m => { m.style.display = 'none'; m.innerHTML = ''; });
      if (open) return;
      mount.style.display = '';
      const i = gap.input;
      mount.innerHTML = i.kind === 'select'
        ? `<select class="select" data-v>${'<option value="">Choose…</option>'}${i.options.map(o => `<option value="${o.key}">${o.label}</option>`).join('')}</select>
           <button class="btn btn-primary btn-sm" data-save>${icon('check')}</button>`
        : `<input class="input" data-v type="${i.kind === 'tel' ? 'tel' : i.kind}" placeholder="${i.placeholder || ''}" ${i.min != null ? `min="${i.min}"` : ''} ${i.max != null ? `max="${i.max}"` : ''} style="width:${i.kind === 'number' ? '90px' : '170px'}" />
           <button class="btn btn-primary btn-sm" data-save>${icon('check')}</button>`;
      mount.querySelector('[data-v]').focus();
      mount.querySelector('[data-save]').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const raw = mount.querySelector('[data-v]').value.trim();
        if (!raw) { showToast('Nothing entered yet', 'warning'); return; }
        const btn = mount.querySelector('[data-save]');
        btn.disabled = true;
        try {
          const fields = gap.patch(raw);
          const { error } = await getSupabase().rpc('update_patient_from_call', { p_patient_id: p.patient_id, p_fields: fields });
          if (error) throw error;
          Object.assign(p, fields);
          row.classList.add('on');
          row.style.pointerEvents = 'none';
          row.querySelector('.stat-ico').className = 'stat-ico ok';
          row.querySelector('.stat-ico').innerHTML = icon('check');
          row.querySelector('.due-meta').textContent = 'Saved. Thank you for asking';
          mount.remove();
          showToast(`${gap.label} recorded`, 'success');
        } catch (err) {
          showToast('Could not save: ' + err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  });
}

// Which call in the journey is this? Drives the guide + which
// questions even appear: call 1 is relationship-only, by design.
// call_stage is unreliable (sticks low), so trust the real call history
// when it says the relationship is further along.
function callNumberOf(p) { return Math.min(Math.max(p.call_stage || 0, (currentHistory || []).length) + 1, 99); }

// Every patient used to be handed over identically, so a mentor met a family
// with an open urgent concern the same way she met a calm one she had spoken to
// last week. This says which band they are in, what put them there, and the one
// thing to lead with. The band and reason come from the database, so this card,
// the patients list and any export agree.
const BAND_LEAD = {
  urgent: {
    tone: 'danger', icon: 'alertCircle', label: 'Urgent',
    lead: 'Something serious was flagged and is still open. Open on it gently before anything else, and do not run the usual script.',
  },
  high: {
    tone: 'warn', icon: 'clock', label: 'Needs attention',
    lead: 'They have waited longer than they should have. Acknowledge the gap early, without apologising into a corner.',
  },
  watch: {
    tone: 'info', icon: 'search', label: 'Worth learning about',
    lead: 'We know very little about this family yet. The Ask today panel below is the priority on this call.',
  },
  steady: {
    tone: 'neutral', icon: 'heart', label: 'Steady',
    lead: 'Nothing is flagged. This is a relationship call: how are they really doing, and what has changed.',
  },
};

function renderPriorityBanner() {
  const pr = currentPatientPriority;
  if (!pr || !pr.band) return '';
  const b = BAND_LEAD[pr.band] || BAND_LEAD.steady;
  const known = (pr.fields_known != null && pr.fields_total)
    ? `${pr.fields_known} of ${pr.fields_total} details on file` : '';
  return `
    <div class="strategy" style="border-left-color:var(--${b.tone === 'neutral' ? 'line-strong' : b.tone})">
      <div class="strategy-head">
        <span class="strategy-ico">${icon(b.icon)}</span>
        <div><div class="strategy-title">${b.label}</div>
        <div class="faint" style="font-size:12.5px;color:var(--ink-3)">${sanitizeText(pr.reason || '')}${known ? ' · ' + known : ''}</div></div>
      </div>
      <p class="strategy-body">${b.lead}</p>
    </div>`;
}

// The portal builds most of its HTML from database text, so anything that
// reaches innerHTML from a row needs escaping.
function sanitizeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderStageGuide(p) {
  const n = callNumberOf(p);
  const g = stageGuide(n);
  const toneColor = g.tone === 'clay' ? 'var(--clay)' : g.tone === 'info' ? 'var(--info)' : 'var(--ok)';
  return `
    <div class="card-flush" style="border:1px solid var(--line);border-left:3px solid ${toneColor};border-radius:var(--r-md);padding:14px 16px;background:var(--surface-2)">
      <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
        <span class="badge badge-${g.tone === 'clay' ? 'danger' : g.tone}" style="background:transparent;border:1px solid ${toneColor};color:${toneColor}">Call ${n >= 3 ? '3+' : n} focus</span>
        <strong style="font:var(--t-body-strong);font-size:14px">${g.title.split(':')[1]?.trim() || g.title}</strong>
      </div>
      <p style="font:var(--t-sm);color:var(--ink-2);margin:7px 0 0">${g.what}</p>
      <details style="margin-top:7px">
        <summary style="font:var(--t-xs);font-weight:700;color:var(--primary);cursor:pointer">Things you can say</summary>
        ${g.openers.map(o => `<p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0;padding-left:10px;border-left:2px solid var(--line-2);font-style:italic">${o}</p>`).join('')}
      </details>
    </div>`;
}

function renderLogForm(p) {
  const pitches = currentPatientPitches || {};
  const callNum = callNumberOf(p);
  const showDeeper = callNum >= 2;   // services, WhatsApp, consent, details
  return `
    <div class="card card-flush logform">
      <div class="lf-head"><h3>How did it go?</h3>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="faint" style="font-size:13px;color:var(--ink-3)">${(p.full_name || '').split(' ')[0]}</span>
          <button type="button" class="btn btn-ghost btn-sm" id="f-concern" title="Flag something a supervisor must see, including how this call is going for you" style="color:var(--danger);gap:6px">${icon('alertTriangle')}Raise a concern</button>
        </div>
      </div>
      <div class="lf-body">
        ${p.consent_given ? `
        <div class="followup" style="background:var(--ok-soft);border-color:var(--ok);padding:10px 12px">
          <div class="fu-head" style="color:var(--ok)">${icon('shieldCheck')}<span>Consent on file</span></div>
          <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">They have already agreed. Anything they tell you today can be saved.</p>
        </div>` : `
        <div class="followup" id="consent-block" style="background:var(--gold-soft);border-color:var(--gold)">
          <div class="fu-head" style="color:var(--gold-deep)">${icon('shieldCheck')}<span>Consent first</span></div>
          <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 10px">${callNum >= 2
            ? '“May I note down a few details about the diagnosis? It stays private and helps our team guide you better.”'
            : '“Is it alright if we stay in touch and keep a few notes about your care? It stays private, and you can ask us to stop any time.”'}</p>
          <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 10px">Until they say yes, nothing about them can be saved. Ask this before anything else.</p>
          <div class="yesno" data-yn="consent"><button type="button" class="yn" data-v="yes">They consented</button><button type="button" class="yn" data-v="no">Not today</button></div>
          <div class="due-meta" id="consent-saved" style="display:none;margin-top:8px;color:var(--ok)"></div>
        </div>`}
        <div class="field"><label>Call outcome <span class="req">*</span></label>
          <div class="seg seg-wrap" id="seg-outcome">
            ${DIAL_STATUSES.map(o => `<button type="button" class="seg-btn" data-status="${o.key}" data-tone="${o.tone}">${icon(o.icon)}<span>${o.label}</span></button>`).join('')}
          </div>
        </div>
        <div class="reveal" id="reveal-connected"><div class="reveal-inner">
          <div class="field"><label>How were they doing? <span class="req">*</span></label>
            <div class="recep" id="recep">${RECEPTIVENESS.map(r => `<button type="button" class="recep-btn" data-recep="${r.key}"><div class="recep-label">${r.label}</div><div class="recep-hint">${r.hint}</div></button>`).join('')}</div>
          </div>
          <div class="field"><label>How is the patient doing?</label>
            <div class="seg" style="grid-template-columns:repeat(5,1fr)" id="seg-condition">
              ${CONDITIONS.map(c => `<button type="button" class="seg-btn" data-cond="${c.key}" data-tone="${c.tone}"><span>${c.label}</span></button>`).join('')}
            </div>
          </div>
          <div class="field"><label>What did they ask for?</label>
            <div class="chips" id="reqs" style="display:flex;flex-wrap:wrap;gap:8px">
              ${REQUIREMENTS.map(r => `<button type="button" class="chip seg-btn" data-req="${r.key}" data-tone="primary" style="padding:8px 12px">${icon(r.icon)}<span>${r.key}</span></button>`).join('')}
            </div>
            <input class="input" id="f-customreq" placeholder="Anything else they asked for…" style="margin-top:8px" />
          </div>
          ${showDeeper ? '<div id="invite-moment"></div>' : ''}
          ${showDeeper ? `
          <button type="button" class="btn btn-secondary" id="f-details-btn">${icon('stethoscope')}Add clinical details they shared</button>
          <div class="field"><label>Services offered today</label>
            <div class="services" id="services">
              ${SERVICES.map(s => { const already = !!pitches[s.column];
                return `<label class="svc${already ? ' on locked' : ''}" data-svc="${s.key}"><input type="checkbox" ${already ? 'checked disabled' : ''} />${icon(s.icon)}<span class="svc-label">${s.label}</span>${already ? '<span class="svc-note">offered earlier</span>' : ''}</label>`; }).join('')}
            </div>
          </div>
          <div class="row gap5 wrap" style="display:flex;gap:20px;flex-wrap:wrap">
            <div class="field grow" style="flex:1;min-width:140px"><label>WhatsApp link sent?</label>
              <div class="yesno" data-yn="waLink"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
            <div class="field grow" style="flex:1;min-width:140px"><label>Joined the WhatsApp group?</label>
              <div class="yesno" data-yn="whatsapp"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
            <div class="field grow" style="flex:1;min-width:140px"><label>Following our channels?</label>
              <div class="yesno" data-yn="social"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
          </div>` : `
          <p style="font:var(--t-xs);color:var(--ink-3);margin:0;padding:10px 12px;background:var(--surface-3);border-radius:var(--r-sm)">
            ${icon('info')} First call. Services, WhatsApp and medical details unlock from the second call. Today is about trust - and consent, if they offer it.
          </p>`}
          <button type="button" class="btn btn-ghost btn-sm" id="f-wellbeing-btn" style="align-self:flex-start">${icon('activity')}Record well-being scores (PHQ-4, QoL…)</button>
          <div class="row gap5 wrap" style="display:flex;gap:20px;flex-wrap:wrap">
            <div class="field grow" style="flex:1;min-width:170px"><label>Feedback from patient</label>
              <input class="input" id="f-fb-patient" placeholder="In their words…" /></div>
            <div class="field grow" style="flex:1;min-width:170px"><label>Feedback from caregiver</label>
              <input class="input" id="f-fb-caregiver" placeholder="In their words…" /></div>
          </div>
        </div></div>
        <div class="field"><label>General notes</label>
          <textarea class="textarea" id="f-notes" placeholder="Anything worth remembering about this conversation…"></textarea></div>
        <div class="followup">
          <div class="fu-head">${icon('calendar')}<span>Next check-in</span><span class="fu-auto" id="fu-auto" style="display:none">suggested for you</span></div>
          <div class="field"><label>Date</label><input class="input" type="date" id="f-followup" min="${addDays(3)}" /></div>
          <div class="field" style="margin-top:12px"><label>A note to hand the next caregiver mentor</label>
            <textarea class="textarea" id="f-strategy" placeholder="What helped, what to lead with, the best time to reach them…"></textarea></div>
        </div>
        <label class="upload">${icon('mic')}<div class="grow" style="flex:1"><div class="up-title" id="up-title">Attach call recording</div><div class="up-sub">Optional · auto-captured on the mobile app</div></div>${icon('upload')}
          <input type="file" accept="audio/*,.m4a,.mp3,.wav,.ogg,.aac" hidden id="f-recording" /></label>
        ${renderLeversPanel(p)}
      </div>
      <div class="lf-actions">
        <button class="btn btn-ghost" id="f-skip">${icon('skip')}Skip for now</button>
        <button class="btn btn-primary grow" id="f-submit" style="flex:1" disabled>${icon('check')}Submit &amp; next call</button>
      </div>
    </div>`;
}

// ---- "Session coming up" banner: with no WhatsApp yet, the mentor IS the
// reminder system: remind them warmly on this very call.
function renderSessionBanner() {
  const live = currentPatientSessions || [];
  const sched = live.filter(s => s.status === 'scheduled' && s.scheduled_at)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
  const agreed = live.find(s => s.status === 'agreed');
  if (sched) {
    const when = new Date(sched.scheduled_at).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `
      <div class="strategy" style="background:var(--ok-soft);border-color:var(--ok)">
        <div class="strategy-head"><span class="strategy-ico" style="color:var(--ok)">${icon('calendar')}</span>
          <div><div class="strategy-title">${sessionKind(sched.kind).label} session · ${when}</div>
          <div class="faint" style="font-size:12.5px;color:var(--ink-3)">Remind them on this call. A personal reminder is what gets people there.</div></div>
        </div>
      </div>`;
  }
  if (agreed) {
    return `
      <div class="strategy">
        <div class="strategy-head"><span class="strategy-ico">${icon('heart')}</span>
          <div><div class="strategy-title">Said yes to a ${sessionKind(agreed.kind).label.toLowerCase()} session</div>
          <div class="faint" style="font-size:12.5px;color:var(--ink-3)">The team is fixing a date, reassure them it's coming.</div></div>
        </div>
      </div>`;
  }
  return '';
}

// ---- Invitation moments: the right time to ask for a 1:1 session.
// Fires from call 2+, only when a signal is live (what they asked for, or
// clear warmth), and never while another invitation is already open.
const INVITE_SCRIPTS = {
  wellbeing: {
    title: 'They could use someone to talk to',
    en: '“Would it help to talk one-on-one with someone from our psychology team? It’s free and completely private, just for you.”',
    hi: '“Agar aap chahein, to hamari team ke saath ek personal baat-cheet ka session rakh sakte hain, bilkul free aur private. Kaisa lagega?”',
  },
  nutrition: {
    title: 'A personal diet plan would land well',
    en: '“Our nutrition team can sit with you one-on-one and make a diet plan for exactly this. Shall I set it up?”',
    hi: '“Hamari nutrition team aapke liye personal diet plan bana sakti hai, ek chhota session rakh doon?”',
  },
  caregiver: {
    title: 'The caregiver needs care too',
    en: '“And for YOU: we have someone caregivers talk to, just for them. Shall I arrange a session?”',
    hi: '“Jo aapki dekhbhal karte hain, unke liye bhi hum ek alag session rakhte hain. Unse baat karaun?”',
  },
};
function inviteKindFromSignals() {
  const asked = (k) => form.requirements.includes(k);
  if (asked('Emotional support')) return 'wellbeing';
  if (asked('Nutrition / diet')) return 'nutrition';
  if (asked('Caregiver support')) return 'caregiver';
  if (form.receptiveness === 'highly_receptive') return 'wellbeing';
  return null;
}
function updateInviteMoment(p) {
  const mount = document.getElementById('invite-moment');
  if (!mount || mount.dataset.done) return;
  const liveKinds = new Set((currentPatientSessions || []).map(s => s.kind));
  const kind = inviteKindFromSignals();
  if (!kind || form.dialStatus !== 'connected' || liveKinds.has(kind)) { mount.innerHTML = ''; return; }
  if (mount.dataset.kind === kind && mount.innerHTML) return;   // already showing this one
  mount.dataset.kind = kind;
  const s = INVITE_SCRIPTS[kind];
  // Nutrition 1:1s are the nutrition team's; well-being and caregiver
  // sessions the mentor can also hold herself: continuity beats handoff.
  const canHoldMyself = kind !== 'nutrition';
  mount.innerHTML = `
    <div class="followup">
      <div class="fu-head">${icon('heart')}<span>Invitation moment · ${s.title}</span></div>
      <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 4px;font-style:italic">${s.en}</p>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 10px;font-style:italic">${s.hi}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${canHoldMyself ? `<button type="button" class="btn btn-primary btn-sm" data-inv="agreed-self">${icon('check')}Yes, I’ll hold it myself</button>` : ''}
        <button type="button" class="btn ${canHoldMyself ? 'btn-secondary' : 'btn-primary'} btn-sm" data-inv="agreed">${icon('check')}${canHoldMyself ? 'Yes, team schedules it' : 'They said yes'}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-inv="invited">They’ll think about it</button>
        <button type="button" class="btn btn-ghost btn-sm" data-inv="skip">Not today</button>
      </div>
    </div>`;
  mount.querySelectorAll('[data-inv]').forEach(btn => btn.addEventListener('click', async () => {
    const choice = btn.dataset.inv;
    if (choice === 'skip') { mount.dataset.done = '1'; mount.innerHTML = ''; return; }
    btn.disabled = true;
    try {
      const sb = getSupabase();
      const status = choice === 'invited' ? 'invited' : 'agreed';
      let assignee = null, continuityName = null;
      if (choice === 'agreed-self') {
        assignee = me.id;
      } else if (status === 'agreed') {
        // Continuity: whoever last worked a session of this kind with this
        // patient gets the follow-up, so the same person carries the plan.
        try {
          const { data: prev } = await sb.from('care_sessions')
            .select('assigned_to, assignee:profiles!care_sessions_assigned_to_fkey(full_name)')
            .eq('patient_id', p.patient_id).eq('kind', kind)
            .in('status', ['held', 'scheduled'])
            .not('assigned_to', 'is', null)
            .order('created_at', { ascending: false }).limit(1);
          if (prev?.[0]) { assignee = prev[0].assigned_to; continuityName = prev[0].assignee?.full_name || null; }
        } catch {}
      }
      const row = { patient_id: p.patient_id, kind, status, invited_by: me.id };
      if (status === 'agreed') row.agreed_at = new Date().toISOString();
      if (assignee) row.assigned_to = assignee;
      const { data, error } = await sb.from('care_sessions').insert(row).select().single();
      if (error) throw error;
      currentPatientSessions = [...(currentPatientSessions || []), data];
      mount.dataset.done = '1';
      const doneMsg = status !== 'agreed'
        ? 'Noted. We’ll ask again gently on a later call.'
        : choice === 'agreed-self'
          ? 'Lovely. It’s yours. Give it a date on the 1:1 Sessions page.'
          : continuityName
            ? `Lovely. Going back to ${continuityName}, who has worked with them before.`
            : `Lovely. The ${sessionKind(kind).label.toLowerCase()} team takes it from here.`;
      mount.innerHTML = `
        <div class="followup" style="display:flex;align-items:center;gap:9px">
          <span style="width:17px;height:17px;display:inline-flex;flex:none;color:var(--ok)">${icon('checkCircle')}</span>
          <span style="font:var(--t-sm);color:var(--ink-2)">${doneMsg}</span>
        </div>`;
      showToast(status === 'agreed'
        ? (choice === 'agreed-self' ? 'Session is yours, schedule it when ready' : continuityName ? `Sent back to ${continuityName} for continuity` : 'Session request sent to the team')
        : 'Invitation noted', 'success');
    } catch (e) {
      showToast('Could not record it: ' + e.message, 'error');
      btn.disabled = false;
    }
  }));
}

function wireActive(p) {
  document.getElementById('t-toggle')?.addEventListener('click', toggleTimer);
  // Typing the minutes is as authoritative as the timer. It stops the clock
  // and becomes the duration that gets logged.
  document.getElementById('t-mins')?.addEventListener('input', (e) => {
    const mins = Math.max(0, Math.min(600, Number(e.target.value) || 0));
    if (timerRunning) stopTimer();
    timerSeconds = mins * 60;
    const t = document.getElementById('t-time'); if (t) t.textContent = fmtTimer(timerSeconds);
    saveActive();
  });
  // Tapping ANY number to dial auto-starts the duration timer, so a caller
  // never loses a call's length just because they forgot to hit "Start".
  // Covers the main "Tap to call" button, every dial-order number, and the
  // caregiver number - multi-phone patients dial from the list, not the main
  // button, which is why their duration was not being tracked.
  document.querySelectorAll('.callbtn, .cg-call').forEach(a =>
    a.addEventListener('click', () => { if (!timerRunning) startTimer(); }));
  // Copy number: tap-to-call fails on some phones, so offer a paste-able number.
  document.getElementById('copy-num')?.addEventListener('click', async (e) => {
    const num = e.currentTarget.dataset.num || '';
    let done = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(num); done = true; } } catch {}
    if (!done) { try { const t = document.createElement('textarea'); t.value = num; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.focus(); t.select(); done = document.execCommand('copy'); t.remove(); } catch {} }
    if (!timerRunning) startTimer();   // copying means they're about to dial
    showToast(done ? `Copied ${num}: paste it into your dialler` : 'Could not copy: long-press the number to copy it', done ? 'success' : 'warning');
  });
  // No number to dial: the only useful move is adding one. The active call
  // (including this form's draft) is saved, so coming back resumes it.
  document.getElementById('open-profile-num')?.addEventListener('click', () => {
    saveActive();
    navigate('patients/' + p.patient_id);
  });
  // Send resources on WhatsApp: curate + send from the business number, mid-call.
  // Straight to the financial + accommodation shelf, the pair the field team
  // asked for by name. Opens the library rather than the send flow.
  document.getElementById('open-shelf-btn')?.addEventListener('click', () => navigate('resources/money_stay'));
  document.getElementById('wa-share-btn')?.addEventListener('click', () => openWhatsappShare({
    patient: { patient_id: p.patient_id, full_name: p.full_name, state: p.state, city: p.city, primary_language: p.primary_language },
    recipients: recipientsFromPatient(p),
  }));
  document.querySelectorAll('#seg-outcome .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    form.dialStatus = btn.dataset.status;
    document.querySelectorAll('#seg-outcome .seg-btn').forEach(b => b.className = 'seg-btn');
    btn.className = `seg-btn on tone-${btn.dataset.tone}`;
    const connected = form.dialStatus === 'connected';
    document.getElementById('reveal-connected')?.classList.toggle('open', connected);
    if (!connected) form.receptiveness = '';
    suggestFollowup(); updateSubmit(); updateInviteMoment(p); saveActive();
  }));
  document.querySelectorAll('#recep .recep-btn').forEach(btn => btn.addEventListener('click', () => {
    form.receptiveness = btn.dataset.recep;
    document.querySelectorAll('#recep .recep-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on'); suggestFollowup(); updateSubmit(); updateInviteMoment(p); saveActive();
  }));
  document.querySelectorAll('#seg-condition .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    form.condition = form.condition === btn.dataset.cond ? '' : btn.dataset.cond;
    document.querySelectorAll('#seg-condition .seg-btn').forEach(b => b.className = 'seg-btn');
    if (form.condition) btn.className = `seg-btn on tone-${btn.dataset.tone}`;
    saveActive();
  }));
  document.querySelectorAll('#reqs .chip').forEach(btn => btn.addEventListener('click', () => {
    const k = btn.dataset.req;
    if (form.requirements.includes(k)) { form.requirements = form.requirements.filter(x => x !== k); btn.className = 'chip seg-btn'; btn.style.padding = '8px 12px'; }
    else { form.requirements.push(k); btn.className = 'chip seg-btn on tone-primary'; btn.style.padding = '8px 12px'; }
    updateInviteMoment(p); saveActive();
  }));
  document.querySelectorAll('#services .svc').forEach(label => {
    const input = label.querySelector('input'); if (input.disabled) return;
    input.addEventListener('change', () => { label.classList.toggle('on', input.checked); const k = label.dataset.svc;
      if (input.checked) form.services.push(k); else form.services = form.services.filter(x => x !== k);
      saveActive(); });
  });
  document.querySelectorAll('.yesno').forEach(group => { const field = group.dataset.yn;
    group.querySelectorAll('.yn').forEach(btn => btn.addEventListener('click', () => { const val = btn.dataset.v === 'yes'; form[field] = val;
      group.querySelectorAll('.yn').forEach(b => b.classList.remove('yes', 'no')); btn.classList.add(val ? 'yes' : 'no'); saveActive();
      if (field === 'consent' && val) recordConsentNow(p); })); });
  const textField = (id, field) => document.getElementById(id)?.addEventListener('input', e => { form[field] = e.target.value; saveActiveSoon(); });
  textField('f-customreq', 'customReq');
  textField('f-fb-patient', 'fbPatient');
  textField('f-fb-caregiver', 'fbCaregiver');
  textField('f-notes', 'notes');
  textField('f-strategy', 'strategy');
  document.getElementById('f-followup')?.addEventListener('input', e => { form.followupDate = e.target.value; form.dateManual = true; document.getElementById('fu-auto').style.display = 'none'; saveActive(); });
  document.getElementById('f-recording')?.addEventListener('change', e => { const f = e.target.files[0]; if (f) document.getElementById('up-title').textContent = f.name; });
  document.getElementById('f-details-btn')?.addEventListener('click', () => openClinicalDetailsModal(p));
  document.getElementById('f-wellbeing-btn')?.addEventListener('click', () => openAssessmentFlow({
    patient: { id: p.patient_id, full_name: p.full_name },
    role: getUserRole(),
    onSaved: () => {},
  }));
  document.getElementById('f-concern')?.addEventListener('click', () => openConcernModal(p));
  document.getElementById('f-skip')?.addEventListener('click', skipPatient);
  document.getElementById('f-submit')?.addEventListener('click', submitCallLog);
}

// ---- Raise a concern: saves IMMEDIATELY, independent of the call log.
// A red flag must never wait for the rest of the form to be filled in.
function openConcernModal(p) {
  const state = { reason: '', severity: 'high', sevTouched: false };
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      This goes straight to the supervisors' queue. You are never expected to carry it alone.
      Flagging it <em>is</em> handling it.</p>
    <div class="field"><label>What did you hear? <span class="req">*</span></label>
      <div class="chips" id="cn-reasons" style="display:flex;flex-wrap:wrap;gap:8px">
        ${CONCERN_REASONS.filter(r => !CALLER_CONCERNS.includes(r.key))
          .map(r => `<button type="button" class="chip seg-btn" data-reason="${r.key}" data-tone="danger" title="${r.hint}" style="padding:8px 12px"><span>${r.label}</span></button>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:var(--s4)">
      <label>Or is this about the call itself?</label>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 8px">If someone speaks to you in a way that is not okay, that is a flag too. You do not have to keep taking those calls.</p>
      <div class="chips" id="cn-reasons-self" style="display:flex;flex-wrap:wrap;gap:8px">
        ${CONCERN_REASONS.filter(r => CALLER_CONCERNS.includes(r.key))
          .map(r => `<button type="button" class="chip seg-btn" data-reason="${r.key}" data-tone="danger" title="${r.hint}" style="padding:8px 12px"><span>${r.label}</span></button>`).join('')}
      </div>
      <label class="svc" id="cn-reassign-wrap" style="display:none;margin-top:10px;align-items:flex-start;gap:9px;padding:10px 12px">
        <input type="checkbox" id="cn-reassign" />
        <span style="font:var(--t-sm)">Take this patient off my list and give them to someone else.
          <span style="display:block;font:var(--t-xs);color:var(--ink-3);margin-top:2px">They come off your list the moment you send this. A supervisor decides who picks them up.</span>
        </span>
      </label>
    </div>
    <div class="field" style="margin-top:var(--s4)"><label>How urgent?</label>
      <div class="seg" style="grid-template-columns:repeat(3,1fr)" id="cn-sev">
        ${CONCERN_SEVERITIES.map(s => `<button type="button" class="seg-btn ${s.key === 'high' ? 'on tone-warn' : ''}" data-sev="${s.key}" data-tone="${s.tone}"><span>${s.label}</span></button>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:var(--s4)"><label>What happened, in your words</label>
      <textarea class="textarea" id="cn-note" placeholder="What they said, what you noticed, anything the supervisor should know first…"></textarea></div>
    <div class="form-actions" style="margin-top:var(--s4)">
      <button class="btn btn-secondary" id="cn-cancel">Cancel</button>
      <button class="btn btn-danger" id="cn-save">${icon('alertTriangle')}Raise it now</button>
    </div>`;
  showModal({ title: `Raise a concern · ${p.full_name || ''}`, content: el, size: 'lg' });

  // One selection across BOTH chip rows: the welfare list and the two that
  // are about the caller. Picking either clears the other.
  const allChips = () => el.querySelectorAll('#cn-reasons .chip, #cn-reasons-self .chip');
  allChips().forEach(btn => btn.addEventListener('click', () => {
    state.reason = btn.dataset.reason;
    allChips().forEach(b => { b.className = 'chip seg-btn'; b.style.padding = '8px 12px'; });
    btn.className = 'chip seg-btn on tone-danger'; btn.style.padding = '8px 12px';
    // Asking to be taken off the call is only offered for the reasons it
    // answers; anything else is a welfare flag and the mentor stays on it.
    const wrap = el.querySelector('#cn-reassign-wrap');
    const box = el.querySelector('#cn-reassign');
    const offerable = CALLER_CONCERNS.includes(state.reason);
    wrap.style.display = offerable ? 'flex' : 'none';
    if (!offerable) box.checked = false;
    // Life-threatening reasons default to urgent unless they chose otherwise.
    if (!state.sevTouched && ['self_harm', 'condition_critical'].includes(state.reason)) {
      state.severity = 'urgent';
      el.querySelectorAll('#cn-sev .seg-btn').forEach(b => b.className = 'seg-btn' + (b.dataset.sev === 'urgent' ? ' on tone-danger' : ''));
    }
  }));
  el.querySelectorAll('#cn-sev .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    state.severity = btn.dataset.sev; state.sevTouched = true;
    el.querySelectorAll('#cn-sev .seg-btn').forEach(b => b.className = 'seg-btn');
    btn.className = `seg-btn on tone-${btn.dataset.tone}`;
  }));
  el.querySelector('#cn-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#cn-save').addEventListener('click', async () => {
    if (!state.reason) { showToast('Pick what you heard. That routes the help', 'warning'); return; }
    const btn = el.querySelector('#cn-save');
    const wantsOff = !!el.querySelector('#cn-reassign')?.checked;
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Raising…';
    try {
      const note = el.querySelector('#cn-note').value.trim() || null;
      if (wantsOff) {
        // One RPC: raises the flag AND takes them off this caller's queue
        // in the same transaction, so she is never told "done" while the
        // person is still on tomorrow's list. sql/113.
        const { error } = await getSupabase().rpc('request_patient_reassignment', {
          p_patient_id: p.patient_id, p_reason: state.reason,
          p_severity: state.severity, p_note: note,
        });
        if (error) throw error;
        closeModal();
        showToast('Sent. They are off your list from now, and a supervisor will pick it up. You did the right thing.', 'success', 8000);
        // The row they were on has just been cancelled: move on rather
        // than leaving her looking at the person she asked to leave.
        stopTimer(); clearActive(); getNextCall();
        return;
      }
      // Was a bare .insert(), which is half of "in concern section multiple
      // patients appear twice or thrice": every automatic flag path already
      // refuses to stack a second live flag for the same patient and reason,
      // and the two manual paths did not. raise_call_concern (sql/116) applies
      // the same rule and appends the new wording to the flag already open,
      // so nothing she typed is lost.
      const { data: res, error } = await getSupabase().rpc('raise_call_concern', {
        p_patient_id: p.patient_id, p_reason: state.reason,
        p_severity: state.severity, p_note: note,
      });
      if (error) throw error;
      closeModal();
      showToast(res?.created === false
        ? 'Added to the flag already open on them. A supervisor has it.'
        : 'Concern raised. A supervisor will see it. Well done for flagging it.', 'success');
    } catch (e) {
      showToast('Could not raise it: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('alertTriangle')}Raise it now`;
    }
  });
}

// Quick capture for what the patient shared verbally on the call:
// the four details that unlock real help. Saves straight to the patient.
function openClinicalDetailsModal(p) {
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">Only fill what they actually told you. Everything is optional.</p>
    <div class="form-row">
      <div class="form-group"><label class="form-label">GI cancer subtype</label>
        <select class="select" id="cd-gi"><option value="">Not sure</option>
          ${GI_SUBTYPES.map(g => `<option value="${g.key}" ${p.gi_subtype === g.key ? 'selected' : ''}>${g.label}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Stage</label>
        <select class="select" id="cd-stage">
          ${['unknown', 'stage_i', 'stage_ii', 'stage_iii', 'stage_iv'].map(s => `<option value="${s}" ${(p.cancer_stage || 'unknown') === s ? 'selected' : ''}>${capitalize(s)}</option>`).join('')}
        </select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Hospital</label>
        <input class="input" id="cd-hospital" value="${p.treating_hospital || ''}" /></div>
      <div class="form-group"><label class="form-label">Current treatment</label>
        <input class="input" id="cd-treatment" value="${p.current_treatment || ''}" placeholder="e.g., chemo cycle 3" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Paying via</label>
        <input class="input" id="cd-payment" value="${p.payment_method || ''}" placeholder="e.g., Ayushman Bharat, savings" /></div>
      <div class="form-group"><label class="form-label">Primary language</label>
        <input class="input" id="cd-language" value="${p.primary_language || ''}" /></div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cd-cancel">Cancel</button>
      <button class="btn btn-primary" id="cd-save">${icon('check')}Save details</button>
    </div>`;
  showModal({ title: 'Clinical details · ' + (p.full_name || ''), content: el, size: 'lg' });
  el.querySelector('#cd-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#cd-save').addEventListener('click', async () => {
    const btn = el.querySelector('#cd-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    const v = (id) => el.querySelector('#' + id)?.value.trim() || null;
    const patch = {
      gi_subtype: v('cd-gi'), cancer_stage: v('cd-stage') || 'unknown',
      treating_hospital: v('cd-hospital'), current_treatment: v('cd-treatment'),
      payment_method: v('cd-payment'), primary_language: v('cd-language'),
    };
    if (patch.gi_subtype) patch.cancer_type = giLabel(patch.gi_subtype);
    Object.keys(patch).forEach(k => { if (patch[k] == null) delete patch[k]; });
    try {
      const { error } = await getSupabase().rpc('update_patient_from_call', { p_patient_id: p.patient_id, p_fields: patch });
      if (error) throw error;
      Object.assign(p, patch);
      closeModal(); showToast('Details saved to the patient record', 'success');
    } catch (e) { showToast('Could not save: ' + e.message, 'error'); btn.disabled = false; btn.innerHTML = `${icon('check')}Save details`; }
  });
}

// A connected call rests the family for 7 days (the queue's connected
// cooldown), so a connected outcome floors both the date-picker min and the
// suggestion at 7 days. Anything earlier would sit in the queue unservable.
function suggestFollowup() {
  const input = document.getElementById('f-followup'); const autoEl = document.getElementById('fu-auto');
  const connected = form.dialStatus === 'connected';
  const minDate = addDays(connected ? 7 : 3);
  if (input) input.min = minDate;
  if (connected && form.dateManual && form.followupDate && form.followupDate < minDate) {
    form.followupDate = minDate;
    if (input) input.value = minDate;
    showToast(`Connected calls rest for 7 days, check-in moved to ${new Date(minDate).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`, 'info');
  }
  if (form.dateManual) return;
  let days = null;
  if (connected) { const r = RECEPTIVENESS.find(x => x.key === form.receptiveness); days = r ? Math.max(r.days, 7) : null; }
  else if (form.dialStatus) days = STATUS_DAYS[form.dialStatus];
  if (days != null) { form.followupDate = addDays(days); if (input) input.value = form.followupDate; if (autoEl) autoEl.style.display = ''; }
  else { form.followupDate = ''; if (input) input.value = ''; if (autoEl) autoEl.style.display = 'none'; }
}
function updateSubmit() { const btn = document.getElementById('f-submit'); if (!btn) return; const connected = form.dialStatus === 'connected'; btn.disabled = !form.dialStatus || (connected && !form.receptiveness); }

// Duration is derived from a wall-clock anchor (timerStartEpoch), never from
// counting ticks, so it stays correct even if the WebView reloads or sleeps
// mid-call (which is exactly what the tel: link does on Android).
function tickTimer() {
  if (timerStartEpoch) timerSeconds = Math.floor((Date.now() - timerStartEpoch) / 1000);
  const t = document.getElementById('t-time'); if (t) t.textContent = fmtTimer(timerSeconds);
}
function paintTimerRunning() {
  const dot = document.getElementById('t-dot'); const toggle = document.getElementById('t-toggle');
  dot?.classList.add('live');
  if (toggle) { toggle.className = 'btn btn-danger'; toggle.innerHTML = `${icon('square')}End call`; }
  clearInterval(timerInterval); timerInterval = setInterval(tickTimer, 1000); tickTimer();
}
function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  timerStartEpoch = Date.now() - timerSeconds * 1000;   // resume-safe anchor
  paintTimerRunning();
  saveActive();
}
function stopTimer() {
  if (!timerRunning) return;
  if (timerStartEpoch) timerSeconds = Math.floor((Date.now() - timerStartEpoch) / 1000);
  timerRunning = false; timerStartEpoch = null;
  clearInterval(timerInterval); timerInterval = null;
  // Mirror what was timed into the minutes box, so the number about to be
  // logged is visible and correctable before submit.
  const mins = document.getElementById('t-mins');
  if (mins && timerSeconds) mins.value = Math.ceil(timerSeconds / 60);
  const dot = document.getElementById('t-dot'); const toggle = document.getElementById('t-toggle');
  dot?.classList.remove('live');
  if (toggle) { toggle.className = 'btn btn-primary'; toggle.innerHTML = `${icon('play')}Start call`; }
  saveActive();
}
function toggleTimer() { if (timerRunning) stopTimer(); else startTimer(); }
// Page reloaded mid-call: re-attach the live UI + ticking without resetting.
function resumeRunningTimer() { paintTimerRunning(); }

// "Skip for now" keeps the patient in the queue. They sink to the back of
// today's list and come back after the rest. Only a submitted outcome
// (connected / not-picked-up) actually removes them from today.
async function skipPatient() {
  if (!currentQueueId) return;
  const sb = getSupabase();
  const name = (currentPatient?.full_name || 'They').split(' ')[0];
  const btn = document.getElementById('f-skip');
  if (btn) btn.disabled = true;
  // skip_call used to return void, so a skip RLS or the queue trigger had
  // already discarded looked exactly like a skip that worked: the toast said
  // "moved down", the draft was wiped, and the patient had not moved at all.
  // It now returns an outcome, so we only clear the call when something
  // really happened, and a refusal keeps every note the caller typed.
  const { data, error } = await sb.rpc('skip_call', { p_queue_id: currentQueueId });
  if (error) {
    if (btn) btn.disabled = false;
    showToast(error.message + ' Your notes are safe. Submit still records this call.', 'error', 7000);
    return;
  }
  const outcome = data?.outcome || 'skipped';
  if (outcome === 'already_handled') {
    if (btn) btn.disabled = false;
    showToast(data.message, 'info');
    return;   // the row stays put, so keep the caller where they are
  }
  // The last servable row has nowhere to sink to: get_next_call would hand
  // the SAME person straight back, which is what "Skip does nothing" is.
  // Say so, and keep the draft rather than wiping it for a no-op.
  if (outcome === 'skipped_alone') {
    if (btn) btn.disabled = false;
    showToast(`${name} is the only person left on your list today, so there is nobody to move them behind. Log this call when you can, or check back after the list is rebuilt.`, 'info', 9000);
    return;
  }
  showToast(outcome === 'skipped'
    ? `${name} moved down, still on your list. We'll circle back`
    : data.message, 'info', outcome === 'skipped' ? 4000 : 7000);
  stopTimer(); clearActive(); getNextCall(currentQueueId);
}

async function submitCallLog() {
  if (!currentPatient || !currentQueueId) return;
  const sb = getSupabase();
  const btn = document.getElementById('f-submit');
  const connected = form.dialStatus === 'connected';
  if (!form.dialStatus) { showToast('Please choose how the call went', 'warning'); return; }
  if (connected && !form.receptiveness) { showToast('Please note how they were doing', 'warning'); return; }
  // A connected call with no minutes on it used to save as a blank duration and
  // quietly drag every talk-time average down. Ask once, right here, instead of
  // making someone correct the log afterwards.
  if (connected && !timerSeconds) {
    const mins = document.getElementById('t-mins');
    if (mins) { mins.focus(); mins.select?.(); }
    showToast('How many minutes did you talk? Type it next to the timer, then submit.', 'warning', 6000);
    return;
  }
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:17px;height:17px;border-width:2.5px"></span>Saving…'; }
  stopTimer();
  try {
    // Duplicate guard: if this caregiver mentor already logged a call for
    // this patient in the last few minutes (double-tap, or a second device),
    // don't create a second row, just advance the queue. This is what was
    // inflating "completed" counts (5 → 7).
    try {
      const since = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: dup } = await sb.from('call_logs').select('id')
        .eq('patient_id', currentPatient.patient_id).eq('caller_id', me.id)
        .gte('call_date', since).limit(1);
      if (dup && dup.length) {
        showToast('Already logged for this person a moment ago, not duplicating', 'info');
        await sb.rpc('complete_queue_call', { p_queue_id: currentQueueId, p_status: 'completed' });
        clearActive();
        setTimeout(() => getNextCall(), 300);
        return;
      }
    } catch (_) { /* guard is best-effort; never block a real log */ }

    const callerName = me.full_name ? me.full_name.toUpperCase() : null;
    const followUp = form.followupDate || null;
    const reqList = [...form.requirements]; if (form.customReq.trim()) reqList.push(form.customReq.trim());
    const structured = { requirements: form.requirements, custom_requirement: form.customReq.trim() || null,
      condition: form.condition || null, services: form.services, whatsapp: form.whatsapp, social: form.social,
      whatsapp_link_sent: form.waLink, consent_taken: form.consent };
    const { data: callLog, error } = await sb.from('call_logs').insert({
      patient_id: currentPatient.patient_id, caller_id: me.id, contacted_by_name: callerName,
      call_date: new Date().toISOString(), dial_status: form.dialStatus,
      call_duration_mins: Math.ceil(timerSeconds / 60) || null,
      receptiveness_bucket: connected ? form.receptiveness : null,
      patient_condition: form.condition || null, structured,
      value_pitch_executed: form.services.length > 0,
      whatsapp_link_sent: form.waLink === true,
      whatsapp_group_joined: form.whatsapp === true, social_media_follow: form.social === true,
      feedback_patient: form.fbPatient.trim() || null,
      feedback_caregiver: form.fbCaregiver.trim() || null,
      caller_notes: form.notes.trim() || null,
      requirements_noted: reqList.length ? reqList.join(', ') : null,
      follow_up_date: followUp,
      // build_daily_assignments schedules from next_followup_date, keep both in sync
      next_followup_date: followUp ? followUp + 'T00:00:00Z' : null,
      followup_strategy_notes: form.strategy.trim() || null, lead_source: 'other',
    }).select().single();
    if (error) throw error;

    if (form.services.length > 0 || (form.consent === true && !form.consentSaved)) {
      const now = new Date().toISOString(); const patch = {};
      form.services.forEach(key => { const svc = SERVICES.find(s => s.key === key); if (svc) patch[svc.column] = now; });
      // recordConsentNow() already wrote this the moment she ticked it, so
      // do not restamp consent_date with the submit time.
      if (form.consent === true && !form.consentSaved) {
        patch.consent_given = true; patch.consent_date = now; patch.consent_method = 'verbal_during_call';
      }
      // RPC instead of a direct update: plain RLS blocks coverage callers
      // and unassigned new leads. The queue claim is the authorisation.
      const { error: pErr } = await sb.rpc('update_patient_from_call', { p_patient_id: currentPatient.patient_id, p_fields: patch });
      if (pErr) console.warn('Patient update failed:', pErr.message);
    }
    const file = document.getElementById('f-recording')?.files?.[0];
    if (file && callLog) { try {
      const fileName = `${currentPatient.patient_id}_${Date.now()}_${file.name}`;
      const { error: upErr } = await sb.storage.from('call-recordings').upload(fileName, file);
      if (!upErr) { const { data: urlData } = sb.storage.from('call-recordings').getPublicUrl(fileName);
        await sb.from('call_recordings').insert({ call_log_id: callLog.id, patient_id: currentPatient.patient_id,
          file_url: urlData?.publicUrl || fileName, file_name: file.name, file_size_bytes: file.size, duration_seconds: timerSeconds, uploaded_by: me.id }); }
    } catch (e) { console.warn('Recording upload failed:', e); } }

    const queueStatus = (form.dialStatus === 'callback_requested') ? 'callback' : 'completed';
    await sb.rpc('complete_queue_call', { p_queue_id: currentQueueId, p_status: queueStatus,
      p_next_followup_date: followUp ? followUp + 'T00:00:00Z' : null, p_strategy_notes: form.strategy.trim() || null,
      p_receptiveness: connected ? form.receptiveness : null });

    clearActive();
    if (callLog?.id) {
      lastLoggedCall = { id: callLog.id, name: (currentPatient.full_name || '').split(' ')[0] || 'that call', at: Date.now() };
    }
    const fName = (currentPatient.full_name || '').split(' ')[0];
    const niceDate = followUp ? new Date(followUp).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : null;
    showToast(niceDate ? `Logged. ${fName}'s next check-in is set for ${niceDate}` : `Logged for ${fName}`, 'success');
    setTimeout(() => getNextCall(), 400);
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('check')}Submit &amp; next call`; }
  }
}

async function mountQueueEmpty() {
  clearActive();
  const el = root(); if (!el) return;

  // Re-read the counter before claiming the day is over. Someone may have been
  // assigned to this mentor since the page loaded, which is exactly the case that
  // got reported: three patients assigned, and this screen still said "done".
  let summary = { pending: 0, done_today: 0 };
  try {
    const { data } = await getSupabase().rpc('get_worklist_summary', { p_caller_id: me.id });
    if (data) summary = data;
  } catch { /* fall through to the empty screen */ }
  if (summary.pending > 0) { await mountReady(); return; }

  const finished = summary.done_today > 0;
  el.innerHTML = `
    ${undoBarHTML()}
    <div class="ready"><div class="ready-card">
      <div class="ready-ico" style="background:var(--ok-soft);color:var(--ok)">${icon(finished ? 'checkCircle' : 'inbox')}</div>
      <h2>${finished ? "That's everyone for now." : 'Nothing queued to you.'}</h2>
      <p>${finished
        ? `You have worked through your list: ${summary.done_today} ${summary.done_today === 1 ? 'call' : 'calls'} today. Every one mattered, take a breath.`
        : emptyReason(summary)}</p>
      ${supervises() ? teamPointerHTML() : ''}
      <button class="btn btn-secondary btn-lg" id="back-ready" style="margin-top:8px">${icon('refresh')}Check again</button>
    </div></div>`;
  document.getElementById('back-ready')?.addEventListener('click', mountReady);
  wireUndoBar();
  document.getElementById('goto-team')?.addEventListener('click', () => navigate('team'));
}

function resetState() {
  currentQueueId = null; currentPatient = null; currentPatientPitches = null; currentPatientPriority = null; currentHistory = []; currentPatientSessions = [];
  Object.assign(form, blankForm()); timerSeconds = 0; timerRunning = false; timerStartEpoch = null;
  clearInterval(timerInterval); timerInterval = null;
}
