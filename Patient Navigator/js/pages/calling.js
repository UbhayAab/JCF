// ============================================================
// Patient Navigator — Smart Calling Portal
// Round-robin call assignment, timer, quick form, recording upload
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { formatDate, formatRelativeTime, capitalize, getDialStatusBadge, getMindsetBadge } from '../utils/formatters.js';

let currentQueueId = null;
let currentPatient = null;
let currentPatientPitches = null;  // pitched_*_at fields from DB
let currentTeamMember = null;
let timerInterval = null;
let timerSeconds = 0;
let userEditedFollowup = false;     // tracks if user manually changed the suggested follow-up date

// Per-service definitions for pitch tracking. Order matches UI rendering.
const PITCH_SERVICES = [
  { key: 'therapy',         label: 'Therapy sessions',       column: 'pitched_therapy_at' },
  { key: 'nutrition',       label: 'Nutrition counselling',  column: 'pitched_nutrition_at' },
  { key: 'caregiver',       label: 'Caregiver support',      column: 'pitched_caregiver_at' },
  { key: 'clinical_trial',  label: 'Clinical trial info',    column: 'pitched_clinical_trial_at' },
  { key: 'financial_aid',   label: 'Financial aid',          column: 'pitched_financial_aid_at' },
];

// How many days from now to suggest the next call, by receptiveness bucket.
// "Did not pick up" cases are handled separately (status != connected).
const FOLLOWUP_DAYS_BY_RECEPTIVENESS = {
  highly_receptive: 2,
  neutral:          7,
  skeptical:        14,
  agitated:         14,
  overwhelmed:      21,
};

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export async function renderCalling(container) {
  const role = getUserRole();
  const profile = getCurrentProfile();

  container.innerHTML = `
    <div class="calling-portal">
      <!-- Left: Patient Card / Empty State -->
      <div class="calling-main" id="calling-main">
        <div class="calling-empty-state" id="calling-empty">
          <div class="calling-empty-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--color-primary-400)">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </div>
          <h2>Ready to make calls</h2>
          <p class="text-muted">Select your name and click "Get Next Call" to start</p>
          <div class="calling-selector">
            <select class="form-select" id="team-member-select" style="max-width:300px">
              <option value="">Select your name...</option>
            </select>
          </div>
          <button class="btn btn-primary btn-lg" id="get-next-call" disabled>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/></svg>
            Get Next Call
          </button>
          <div class="calling-queue-stats" id="queue-stats"></div>
        </div>

        <!-- Active Call Card (hidden initially) -->
        <div class="calling-active hidden" id="calling-active">
          <div class="calling-patient-card card">
            <div class="calling-card-header">
              <div class="calling-patient-name" id="cp-name">—</div>
              <div class="calling-attempt-badge" id="cp-attempt"></div>
            </div>
            <div class="calling-card-body">
              <div class="calling-info-grid">
                <div class="calling-info-item">
                  <span class="calling-info-label">Phone</span>
                  <a class="calling-phone-link" id="cp-phone" href="tel:">—</a>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Age / Gender</span>
                  <span id="cp-age-gender">—</span>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Location</span>
                  <span id="cp-location">—</span>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Cancer Type</span>
                  <span id="cp-cancer" class="text-primary">—</span>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Stage</span>
                  <span id="cp-stage">—</span>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Treatment</span>
                  <span id="cp-treatment">—</span>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Payment</span>
                  <span id="cp-payment">—</span>
                </div>
                <div class="calling-info-item">
                  <span class="calling-info-label">Caregiver</span>
                  <span id="cp-caregiver">—</span>
                </div>
              </div>
              <div class="calling-caregiver-phone hidden" id="cp-caregiver-phone-row">
                <span class="calling-info-label">Caregiver Phone</span>
                <a class="calling-phone-link" id="cp-caregiver-phone" href="tel:">—</a>
              </div>
            </div>

            <!-- Timer -->
            <div class="calling-timer-section">
              <div class="calling-timer" id="call-timer">00:00</div>
              <div class="calling-timer-actions">
                <button class="btn btn-success btn-sm" id="timer-start">▶ Start Call</button>
                <button class="btn btn-danger btn-sm hidden" id="timer-stop">⏹ End Call</button>
              </div>
            </div>

            <!-- Call History -->
            <div class="calling-history" id="cp-history"></div>
          </div>
        </div>
      </div>

      <!-- Right: Call Form -->
      <div class="calling-form-panel hidden" id="calling-form-panel">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Log Interaction</div>
          </div>
          <form id="call-log-form">
            <div class="form-group">
              <label class="form-label">Dial Status <span class="required">*</span></label>
              <select class="form-select" id="cf-status" required>
                <option value="">Select...</option>
                <option value="connected">✅ Connected</option>
                <option value="no_answer">📵 No Answer</option>
                <option value="busy">🔴 Busy</option>
                <option value="callback_requested">📞 Callback Requested</option>
                <option value="wrong_number">❌ Wrong Number</option>
                <option value="voicemail">📨 Voicemail</option>
              </select>
            </div>

            <div id="connected-fields" class="hidden">
              <div class="form-group">
                <label class="form-label">Patient Receptiveness Bucket <span class="required">*</span></label>
                <select class="form-select" id="cf-receptiveness">
                  <option value="">Select bucket...</option>
                  <option value="highly_receptive">🌟 Highly Receptive (Open to therapy/nutrition)</option>
                  <option value="neutral">😐 Neutral (Listening but not committed)</option>
                  <option value="skeptical">🤔 Skeptical (Needs more convincing/trust)</option>
                  <option value="agitated">💢 Agitated (Upset, wants quick answers)</option>
                  <option value="overwhelmed">😰 Overwhelmed (Too much going on, needs space)</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Services pitched on this call</label>
                <span class="form-hint">Tick what you offered today. Already-pitched services are greyed out so you don't repeat the pitch.</span>
                <div id="cf-pitches" style="display:flex;flex-direction:column;gap:var(--space-2);margin-top:var(--space-2)">
                  <!-- Populated dynamically per patient in renderPitchCheckboxes() -->
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">WhatsApp Joined?</label>
                  <div class="flex gap-4">
                    <label class="flex items-center gap-2"><input type="radio" name="cf-whatsapp" value="yes"> Yes</label>
                    <label class="flex items-center gap-2"><input type="radio" name="cf-whatsapp" value="no" checked> No</label>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">Social Follow?</label>
                  <div class="flex gap-4">
                    <label class="flex items-center gap-2"><input type="radio" name="cf-social" value="yes"> Yes</label>
                    <label class="flex items-center gap-2"><input type="radio" name="cf-social" value="no" checked> No</label>
                  </div>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Requirements / Asks</label>
                <textarea class="form-textarea" id="cf-requirements" rows="2" placeholder="Finance, nutrition, emotional support..."></textarea>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">General Notes</label>
              <textarea class="form-textarea" id="cf-notes" rows="2" placeholder="Brief interaction notes..."></textarea>
            </div>

            <div class="form-group" style="padding:1rem;background:rgba(255,255,255,0.02);border:1px solid var(--glass-border);border-radius:var(--radius-md);margin-top:1rem;">
              <h5 style="margin-top:0;margin-bottom:0.5rem;color:var(--color-primary-400)">Intelligent Follow-up</h5>
              <div class="form-group">
                <label class="form-label">Next Follow-up Date</label>
                <input type="date" class="form-input" id="cf-followup" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Follow-up Strategy / Judgment</label>
                <textarea class="form-textarea" id="cf-strategy" rows="2" placeholder="e.g., Patient was agitated today, call in 2 weeks with a softer approach."></textarea>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Upload Recording <span class="text-muted">(optional)</span></label>
              <input type="file" class="form-input" id="cf-recording" accept="audio/*,.m4a,.mp3,.wav,.ogg,.aac" />
              <span class="form-hint">Select audio file from your phone's call recorder</span>
            </div>

            <div class="form-actions">
              <button type="button" class="btn btn-ghost" id="cf-skip">Skip Patient</button>
              <button type="submit" class="btn btn-primary" id="cf-submit">Submit & Next Call</button>
            </div>
          </form>
        </div>

        <!-- Today's Stats -->
        <div class="card" style="margin-top:var(--space-4)">
          <div class="card-header"><div class="card-title">Today's Calls</div></div>
          <div id="today-calls-list"></div>
        </div>
      </div>
    </div>
  `;

  // Load team members
  await loadTeamMembers();

  // Event listeners
  document.getElementById('team-member-select')?.addEventListener('change', (e) => {
    currentTeamMember = e.target.value || null;
    document.getElementById('get-next-call').disabled = !currentTeamMember;
  });

  document.getElementById('get-next-call')?.addEventListener('click', getNextCall);
  document.getElementById('timer-start')?.addEventListener('click', startTimer);
  document.getElementById('timer-stop')?.addEventListener('click', stopTimer);
  document.getElementById('cf-skip')?.addEventListener('click', skipPatient);

  document.getElementById('cf-status')?.addEventListener('change', (e) => {
    const show = e.target.value === 'connected';
    document.getElementById('connected-fields')?.classList.toggle('hidden', !show);
    // For non-connected statuses (no answer / busy / wrong number), suggest a
    // sensible re-attempt window so the caller doesn't have to think about it.
    if (!show && !userEditedFollowup) {
      const status = e.target.value;
      const followupEl = document.getElementById('cf-followup');
      if (followupEl) {
        if (status === 'no_answer' || status === 'busy' || status === 'voicemail') {
          followupEl.value = addDays(new Date(), 3);
        } else if (status === 'callback_requested') {
          followupEl.value = addDays(new Date(), 1);
        } else if (status === 'wrong_number') {
          followupEl.value = '';
        }
      }
    }
  });

  // When the caller picks a receptiveness bucket, auto-suggest the next-call
  // date based on the org's playbook (unless the caller already set one).
  document.getElementById('cf-receptiveness')?.addEventListener('change', (e) => {
    if (userEditedFollowup) return;
    const days = FOLLOWUP_DAYS_BY_RECEPTIVENESS[e.target.value];
    if (days != null) {
      const followupEl = document.getElementById('cf-followup');
      if (followupEl) followupEl.value = addDays(new Date(), days);
    }
  });

  // Track manual edits so we don't overwrite the caller's choice.
  document.getElementById('cf-followup')?.addEventListener('input', () => {
    userEditedFollowup = true;
  });

  document.getElementById('call-log-form')?.addEventListener('submit', submitCallLog);

  // Load queue stats
  loadQueueStats();
}

async function loadTeamMembers() {
  const sb = getSupabase();
  try {
    const { data } = await sb.from('team_members').select('*').eq('is_active', true).order('name');
    const select = document.getElementById('team-member-select');
    if (!select || !data) return;
    data.forEach(tm => {
      const opt = document.createElement('option');
      opt.value = tm.id;
      opt.textContent = tm.name;
      select.appendChild(opt);
    });
  } catch (err) { console.error('Load team members error:', err); }
}

async function loadQueueStats() {
  const sb = getSupabase();
  try {
    const { count: pending } = await sb.from('call_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    const { count: completed } = await sb.from('call_queue').select('*', { count: 'exact', head: true }).eq('status', 'completed');
    const { count: total } = await sb.from('call_queue').select('*', { count: 'exact', head: true });

    const el = document.getElementById('queue-stats');
    if (el) {
      el.innerHTML = `
        <div class="flex gap-6" style="margin-top:var(--space-4)">
          <div class="text-center">
            <div class="stat-value" style="font-size:var(--font-2xl)">${pending || 0}</div>
            <div class="text-muted" style="font-size:var(--font-xs)">In Queue</div>
          </div>
          <div class="text-center">
            <div class="stat-value" style="font-size:var(--font-2xl)">${completed || 0}</div>
            <div class="text-muted" style="font-size:var(--font-xs)">Completed</div>
          </div>
          <div class="text-center">
            <div class="stat-value" style="font-size:var(--font-2xl)">${total || 0}</div>
            <div class="text-muted" style="font-size:var(--font-xs)">Total</div>
          </div>
        </div>
      `;
    }
  } catch (err) { console.error('Queue stats error:', err); }
}

async function getNextCall() {
  if (!currentTeamMember) { showToast('Please select your name first', 'warning'); return; }

  const sb = getSupabase();
  const btn = document.getElementById('get-next-call');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0 auto"></div>';

  try {
    const { data, error } = await sb.rpc('get_next_call', { p_team_member_id: currentTeamMember });
    if (error) throw error;

    if (!data || !data.found) {
      showToast('No more calls in queue! Add patients via Team Management.', 'info');
      btn.disabled = false;
      btn.innerHTML = 'Get Next Call';
      return;
    }

    currentQueueId = data.queue_id;
    currentPatient = data;

    // Show active call card
    document.getElementById('calling-empty').classList.add('hidden');
    document.getElementById('calling-active').classList.remove('hidden');
    document.getElementById('calling-form-panel').classList.remove('hidden');

    // Populate patient info
    document.getElementById('cp-name').textContent = data.full_name;
    document.getElementById('cp-attempt').textContent = `Attempt ${data.attempt}`;
    document.getElementById('cp-attempt').className = `calling-attempt-badge badge badge-${data.attempt > 2 ? 'danger' : data.attempt > 1 ? 'warning' : 'info'}`;

    const phoneEl = document.getElementById('cp-phone');
    if (data.phone_full) {
      phoneEl.textContent = data.phone_full;
      phoneEl.href = `tel:${data.phone_full}`;
    } else {
      phoneEl.textContent = 'No phone';
      phoneEl.href = '#';
    }

    document.getElementById('cp-age-gender').textContent = `${data.age || '—'} / ${capitalize(data.gender || 'unknown')}`;
    document.getElementById('cp-location').textContent = [data.city, data.state].filter(Boolean).join(', ') || '—';
    document.getElementById('cp-cancer').textContent = data.cancer_type || 'Not reported';
    document.getElementById('cp-stage').textContent = capitalize(data.cancer_stage || 'unknown');
    document.getElementById('cp-treatment').textContent = data.current_treatment || '—';
    document.getElementById('cp-payment').textContent = data.payment_method || '—';

    if (data.caregiver_name) {
      document.getElementById('cp-caregiver').textContent = `${data.caregiver_name} (${data.caregiver_relationship || '—'})`;
    } else {
      document.getElementById('cp-caregiver').textContent = '—';
    }

    // Show historical strategy if this is a follow-up
    if (data.followup_strategy_notes) {
      const historyEl = document.getElementById('cp-history');
      if (historyEl) {
        historyEl.innerHTML = `
          <div style="background:rgba(255,165,0,0.1);border:1px solid rgba(255,165,0,0.3);padding:var(--space-3);border-radius:var(--radius-md);margin-bottom:var(--space-3)">
            <h5 style="margin:0 0 var(--space-1) 0;color:#ffa500;font-size:var(--font-xs);text-transform:uppercase;letter-spacing:1px;">Follow-up Strategy (From Last Call)</h5>
            <p style="margin:0;font-size:var(--font-sm)">${data.followup_strategy_notes}</p>
            ${data.receptiveness_bucket ? `<div style="margin-top:var(--space-2)"><span class="badge badge-neutral">Bucket: ${data.receptiveness_bucket.replace('_', ' ')}</span></div>` : ''}
          </div>
        `;
      }
    } else {
      document.getElementById('cp-history').innerHTML = '';
    }

    if (data.caregiver_phone_full) {
      document.getElementById('cp-caregiver-phone-row').classList.remove('hidden');
      const cgPhone = document.getElementById('cp-caregiver-phone');
      cgPhone.textContent = data.caregiver_phone_full;
      cgPhone.href = `tel:${data.caregiver_phone_full}`;
    } else {
      document.getElementById('cp-caregiver-phone-row').classList.add('hidden');
    }

    // Reset form
    document.getElementById('call-log-form').reset();
    document.getElementById('connected-fields').classList.add('hidden');
    userEditedFollowup = false;

    // Fetch the patient's pitch history so the checkboxes can show
    // already-pitched services as greyed out (so we don't re-pitch).
    await loadPatientPitches(data.patient_id);
    renderPitchCheckboxes();

    // Reset timer
    timerSeconds = 0;
    document.getElementById('call-timer').textContent = '00:00';
    document.getElementById('timer-start').classList.remove('hidden');
    document.getElementById('timer-stop').classList.add('hidden');

    // Load call history for this patient (excluding strategy banner if rendered)
    const historyContainer = document.createElement('div');
    historyContainer.id = 'cp-history-list';
    document.getElementById('cp-history').appendChild(historyContainer);
    await loadPatientHistory(data.patient_id, historyContainer);

    // Load today's calls
    await loadTodayCalls();

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Get Next Call';
  }
}

async function loadPatientPitches(patientId) {
  const sb = getSupabase();
  try {
    const cols = PITCH_SERVICES.map(s => s.column).join(',');
    const { data } = await sb.from('patients').select(cols).eq('id', patientId).single();
    currentPatientPitches = data || {};
  } catch (err) {
    console.error('Load pitches error:', err);
    currentPatientPitches = {};
  }
}

function renderPitchCheckboxes() {
  const container = document.getElementById('cf-pitches');
  if (!container) return;
  const pitches = currentPatientPitches || {};
  container.innerHTML = PITCH_SERVICES.map(s => {
    const previouslyPitched = !!pitches[s.column];
    const datePitched = previouslyPitched ? new Date(pitches[s.column]).toLocaleDateString() : null;
    return `
      <label class="form-checkbox" style="${previouslyPitched ? 'opacity:0.55' : ''}">
        <input type="checkbox" name="cf-pitch-service" value="${s.key}" ${previouslyPitched ? 'checked disabled' : ''} />
        <span>${s.label}${previouslyPitched ? ` <small class="text-muted">— pitched ${datePitched}</small>` : ''}</span>
      </label>
    `;
  }).join('');
}

async function loadPatientHistory(patientId, container) {
  const sb = getSupabase();
  try {
    const { data } = await sb.from('call_logs')
      .select('*')
      .eq('patient_id', patientId)
      .order('call_date', { ascending: false })
      .limit(5);

    const el = container || document.getElementById('cp-history');
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML += '<div class="text-muted" style="padding:var(--space-3) 0;font-size:var(--font-sm)">No previous interactions logged</div>';
      return;
    }

    el.innerHTML += `
      <div style="font-size:var(--font-sm);font-weight:600;padding:var(--space-3) 0 var(--space-1);color:var(--color-text-muted)">Previous Calls</div>
      ${data.map(c => `
        <div class="calling-history-item">
          <div>${getDialStatusBadge(c.dial_status)} <span class="text-muted">${formatRelativeTime(c.call_date)}</span></div>
          <div class="text-muted" style="font-size:var(--font-xs)">${c.contacted_by_name || '—'} • ${c.call_duration_mins || 0}min${c.caller_notes ? ' • ' + c.caller_notes.slice(0, 60) + '...' : ''}</div>
        </div>
      `).join('')}
    `;
  } catch (err) { console.error('Load history error:', err); }
}

async function loadTodayCalls() {
  if (!currentTeamMember) return;
  const sb = getSupabase();
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: tm } = await sb.from('team_members').select('name').eq('id', currentTeamMember).single();
    if (!tm) return;

    const { data } = await sb.from('call_logs')
      .select('*, patients(full_name, patient_code)')
      .eq('contacted_by_name', tm.name.toUpperCase())
      .gte('call_date', today + 'T00:00:00')
      .order('call_date', { ascending: false })
      .limit(20);

    const el = document.getElementById('today-calls-list');
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:var(--space-6)"><p>No calls today yet</p></div>';
      return;
    }

    el.innerHTML = data.map(c => `
      <div class="flex items-center gap-3" style="padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--glass-border)">
        <div class="flex-1">
          <div class="font-medium text-primary" style="font-size:var(--font-sm)">${c.patients?.full_name || '—'}</div>
          <div class="text-muted" style="font-size:var(--font-xs)">${formatRelativeTime(c.call_date)}</div>
        </div>
        ${getDialStatusBadge(c.dial_status)}
      </div>
    `).join('');
  } catch (err) { console.error('Load today calls error:', err); }
}

function startTimer() {
  document.getElementById('timer-start').classList.add('hidden');
  document.getElementById('timer-stop').classList.remove('hidden');
  const timerEl = document.getElementById('call-timer');
  timerEl.classList.add('timer-active');

  timerInterval = setInterval(() => {
    timerSeconds++;
    const mins = Math.floor(timerSeconds / 60).toString().padStart(2, '0');
    const secs = (timerSeconds % 60).toString().padStart(2, '0');
    timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById('timer-stop').classList.add('hidden');
  document.getElementById('timer-start').classList.remove('hidden');
  document.getElementById('call-timer').classList.remove('timer-active');
}

async function skipPatient() {
  if (!currentQueueId) return;
  const sb = getSupabase();
  try {
    await sb.rpc('complete_queue_call', { p_queue_id: currentQueueId, p_status: 'skipped' });
    showToast('Patient skipped', 'info');
    resetCallView();
    getNextCall();
  } catch (err) { showToast('Skip failed: ' + err.message, 'error'); }
}

async function submitCallLog(e) {
  e.preventDefault();
  if (!currentPatient || !currentQueueId) return;

  const sb = getSupabase();
  const profile = getCurrentProfile();
  const submitBtn = document.getElementById('cf-submit');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0 auto"></div>';

  stopTimer();

  try {
    const dialStatus = document.getElementById('cf-status').value;
    if (!dialStatus) { showToast('Please select dial status', 'warning'); submitBtn.disabled = false; submitBtn.textContent = 'Submit & Next Call'; return; }

    const receptiveness = document.getElementById('cf-receptiveness')?.value || null;
    if (dialStatus === 'connected' && !receptiveness) { 
      showToast('Please select a Receptiveness Bucket', 'warning'); 
      submitBtn.disabled = false; submitBtn.textContent = 'Submit & Next Call'; 
      return; 
    }

    // Collect newly-pitched services from the checkboxes (already-pitched ones
    // are disabled in the UI, so they won't appear here — that's intentional).
    const newlyPitchedKeys = Array.from(
      document.querySelectorAll('input[name="cf-pitch-service"]:checked:not(:disabled)')
    ).map(el => el.value);

    const whatsappEl = document.querySelector('input[name="cf-whatsapp"]:checked');
    const socialEl = document.querySelector('input[name="cf-social"]:checked');
    const notes = document.getElementById('cf-notes')?.value?.trim() || null;
    const requirements = document.getElementById('cf-requirements')?.value?.trim() || null;
    const followUp = document.getElementById('cf-followup')?.value || null;
    const strategy = document.getElementById('cf-strategy')?.value?.trim() || null;

    // Get team member name
    const { data: tm } = await sb.from('team_members').select('name').eq('id', currentTeamMember).single();
    const callerName = tm?.name?.toUpperCase() || null;

    // Insert call log
    const { data: callLog, error } = await sb.from('call_logs').insert({
      patient_id: currentPatient.patient_id,
      caller_id: profile?.id || null,
      contacted_by_name: callerName,
      call_date: new Date().toISOString(),
      dial_status: dialStatus,
      call_duration_mins: Math.ceil(timerSeconds / 60) || null,
      receptiveness_bucket: receptiveness,
      // Mark the legacy boolean true if ANY service was pitched on this call
      value_pitch_executed: newlyPitchedKeys.length > 0,
      whatsapp_group_joined: whatsappEl?.value === 'yes',
      social_media_follow: socialEl?.value === 'yes',
      caller_notes: notes,
      requirements_noted: requirements,
      follow_up_date: followUp,
      followup_strategy_notes: strategy,
      lead_source: 'other',
    }).select().single();

    if (error) throw error;

    // Persist newly-pitched services as timestamps on the patient record so
    // future calls show those services as already-pitched (greyed out).
    if (newlyPitchedKeys.length > 0) {
      const now = new Date().toISOString();
      const patientUpdate = {};
      newlyPitchedKeys.forEach(key => {
        const svc = PITCH_SERVICES.find(s => s.key === key);
        if (svc) patientUpdate[svc.column] = now;
      });
      const { error: pitchErr } = await sb
        .from('patients')
        .update(patientUpdate)
        .eq('id', currentPatient.patient_id);
      if (pitchErr) console.warn('Pitch timestamp update failed:', pitchErr.message);
    }

    // Handle recording upload
    const recordingFile = document.getElementById('cf-recording')?.files?.[0];
    if (recordingFile && callLog) {
      try {
        const fileName = `${currentPatient.patient_id}_${Date.now()}_${recordingFile.name}`;
        const { error: uploadErr } = await sb.storage.from('call-recordings').upload(fileName, recordingFile);
        if (!uploadErr) {
          const { data: urlData } = sb.storage.from('call-recordings').getPublicUrl(fileName);
          await sb.from('call_recordings').insert({
            call_log_id: callLog.id,
            patient_id: currentPatient.patient_id,
            file_url: urlData?.publicUrl || fileName,
            file_name: recordingFile.name,
            file_size_bytes: recordingFile.size,
            duration_seconds: timerSeconds,
            uploaded_by: profile?.id,
          });
        }
      } catch (recErr) { console.warn('Recording upload failed:', recErr); }
    }

    // Mark queue entry and potentially create the follow-up queue entry
    const queueStatus = (dialStatus === 'callback_requested' || followUp) ? 'scheduled' : 'completed';
    await sb.rpc('complete_queue_call', { 
      p_queue_id: currentQueueId, 
      p_status: queueStatus,
      p_next_followup_date: followUp ? followUp + 'T00:00:00Z' : null,
      p_strategy_notes: strategy,
      p_receptiveness: receptiveness
    });

    showToast('Interaction logged successfully!', 'success');
    resetCallView();

    // Auto-get next
    setTimeout(() => getNextCall(), 500);

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit & Next Call';
  }
}

function resetCallView() {
  currentQueueId = null;
  currentPatient = null;
  currentPatientPitches = null;
  userEditedFollowup = false;
  timerSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = null;

  document.getElementById('calling-empty')?.classList.remove('hidden');
  document.getElementById('calling-active')?.classList.add('hidden');
  document.getElementById('calling-form-panel')?.classList.add('hidden');
  loadQueueStats();
}
