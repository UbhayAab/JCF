// ============================================================
// Patient Navigator: 1:1 Sessions (the care pipeline)
// invited → agreed → scheduled → held. Mentors invite from the
// Calling Portal; this page is where therapists / nutritionists /
// managers pick sessions up, schedule them, and record outcomes.
// Marking one "held" auto-syncs the patient_services lever (sql/43),
// so impact analytics count every session.
// ============================================================

import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentProfile, getUserRole, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { SESSION_KINDS, sessionKind, sessionStatus } from '../utils/catalog.js';

let rows = [];
let kindFilter = 'all';
let containerEl = null;
let assignables = null;   // cached profiles for the schedule modal (managers)

export async function renderSessions(container) {
  containerEl = container;
  // Specialists land on their own lane by default.
  const role = getUserRole();
  if (kindFilter === 'all' && role === 'nutritionist') kindFilter = 'nutrition';

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>1:1 Sessions</h1>
        <p class="header-subtitle" style="margin:4px 0 0">The pipeline from a "yes" on a call to a session held: <strong>invited → said yes → scheduled → held</strong>. Mentors invite; this page is where the specialist teams give it a date, hold it, and write one honest line.</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="ss-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div class="chip-row" id="ss-kinds" style="margin-bottom:var(--s3)">
      <button class="fchip ${kindFilter === 'all' ? 'on' : ''}" data-kind="all">All</button>
      ${SESSION_KINDS.map(k => `<button class="fchip ${kindFilter === k.key ? 'on' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}
    </div>
    <div id="ss-def" class="due-meta" style="margin-bottom:var(--s5);max-width:720px"></div>
    <div id="ss-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading sessions…</div></div>`;

  container.querySelector('#ss-refresh')?.addEventListener('click', load);
  container.querySelectorAll('#ss-kinds .fchip').forEach(ch => ch.addEventListener('click', () => {
    kindFilter = ch.dataset.kind;
    container.querySelectorAll('#ss-kinds .fchip').forEach(c => c.classList.toggle('on', c === ch));
    paint();
  }));
  await load();
}

// The three kinds, defined: shown under the chips for whichever is selected.
function paintKindStrip() {
  const chips = containerEl?.querySelectorAll('#ss-kinds .fchip') || [];
  chips.forEach(ch => {
    const k = ch.dataset.kind;
    const n = k === 'all' ? rows.length : rows.filter(r => r.kind === k).length;
    const label = k === 'all' ? 'All' : SESSION_KINDS.find(s => s.key === k)?.label || k;
    ch.textContent = `${label} · ${n}`;
  });
  const def = containerEl?.querySelector('#ss-def');
  if (!def) return;
  if (kindFilter === 'all') {
    def.innerHTML = `Three kinds of 1:1: <strong>Well-being / therapy</strong> (patient, counselling team), <strong>Nutrition</strong> (patient, nutrition team), <strong>Caregiver support</strong> (the family carer, counselling team). Pick a lane to see just yours.`;
  } else {
    const k = SESSION_KINDS.find(s => s.key === kindFilter);
    def.innerHTML = k ? `<strong>${k.label}</strong>. ${k.desc}` : '';
  }
}

async function load() {
  const sb = getSupabase();
  const body = containerEl?.querySelector('#ss-body');
  if (!body) return;
  try {
    const { data, error } = await sb.from('care_sessions').select(`*,
        patient:patients(id, full_name, patient_code, city, state, phone_full, primary_language),
        inviter:profiles!care_sessions_invited_by_fkey(full_name),
        assignee:profiles!care_sessions_assigned_to_fkey(full_name)`)
      .order('created_at', { ascending: false })
      .limit(400);
    if (error) throw error;
    rows = data || [];
    paint();
  } catch (e) {
    body.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Could not load sessions</h4><p>${e.message}</p></div>`;
  }
}

const inKind = (r) => kindFilter === 'all' || r.kind === kindFilter;

function paint() {
  const body = containerEl?.querySelector('#ss-body');
  if (!body) return;
  paintKindStrip();
  const f = rows.filter(inKind);
  const agreed = f.filter(r => r.status === 'agreed').sort((a, b) => new Date(a.agreed_at || a.created_at) - new Date(b.agreed_at || b.created_at));
  const scheduled = f.filter(r => r.status === 'scheduled').sort((a, b) => new Date(a.scheduled_at || 0) - new Date(b.scheduled_at || 0));
  const invited = f.filter(r => r.status === 'invited').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const past = f.filter(r => ['held', 'declined', 'no_show', 'cancelled'].includes(r.status));
  const heldCount = past.filter(r => r.status === 'held').length;

  body.innerHTML = `
    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s4);margin-bottom:var(--s5)">
      ${statCard('Said yes: needs a date', agreed.length, agreed.length ? 'warn' : 'ok', 'calendar')}
      ${statCard('Scheduled', scheduled.length, 'info', 'clock')}
      ${statCard('Thinking it over', invited.length, 'neutral', 'message')}
      ${statCard('Sessions held', heldCount, 'ok', 'checkCircle')}
    </div>

    ${!agreed.length && !scheduled.length && !invited.length ? `
      <div class="empty" style="margin-bottom:var(--s5)">
        <div class="ico-wrap">${icon('calendar')}</div>
        <h4>Nothing in the pipeline${kindFilter === 'all' ? '' : ` for ${sessionKind(kindFilter).label.toLowerCase()}`}</h4>
        <p>Sessions start on calls: when a patient says yes to a 1:1, the mentor logs the invite and it lands here, first as <strong>invited</strong>, then <strong>said yes</strong>, then <strong>scheduled</strong>, then <strong>held</strong>.${past.length ? ' Past sessions are in History below.' : ''}</p>
      </div>` : ''}
    ${section('Said yes: give them a date', 'The warmest moment to act. A quick date keeps the yes alive.', agreed, 'agreed')}
    ${section('Scheduled: coming up', 'Mentors remind patients on their regular calls.', scheduled, 'scheduled')}
    ${section('Invited: thinking it over', 'No pressure. The next call will ask again, gently.', invited, 'invited')}

    ${past.length ? `
      <details class="card" style="margin-top:var(--s5);padding:16px 18px">
        <summary style="cursor:pointer;font:var(--t-body-strong);display:flex;align-items:center;gap:8px">
          <span style="width:17px;height:17px;display:inline-flex;color:var(--ok)">${icon('checkCircle')}</span>
          History · ${past.length}
        </summary>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
          ${past.slice(0, 50).map(r => {
            const st = sessionStatus(r.status);
            return `<div style="border-left:3px solid var(--line-2);padding:8px 12px;background:var(--surface-2);border-radius:var(--r-sm)">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <strong style="font-size:13.5px">${pname(r)}</strong>
                <span class="badge badge-${st.tone}">${st.label}</span>
                <span class="badge badge-neutral">${sessionKind(r.kind).label}</span>
                <span class="hist-meta">${r.status === 'held' ? `${r.assignee?.full_name || 'N/A'} · ${r.duration_mins ? r.duration_mins + ' min · ' : ''}${formatRelativeTime(r.held_at)}` : formatRelativeTime(r.updated_at || r.created_at)}</span>
              </div>
              ${r.session_notes ? `<div style="font:var(--t-xs);color:var(--ink-2);margin-top:4px">${r.session_notes}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </details>` : ''}`;

  // wire actions
  body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id, act = b.dataset.act;
    if (act === 'schedule') openScheduleModal(id);
    else if (act === 'held') openHeldModal(id);
    else if (act === 'agreed') quickUpdate(id, { status: 'agreed', agreed_at: new Date().toISOString() }, 'They said yes. Now give it a date');
    else if (act === 'declined') quickUpdate(id, { status: 'declined' }, 'Noted: no session this time');
    else if (act === 'no_show') quickUpdate(id, { status: 'no_show' }, 'Marked as no-show. A mentor can re-invite later');
    else if (act === 'cancelled') quickUpdate(id, { status: 'cancelled' }, 'Session cancelled');
  }));
  body.querySelectorAll('[data-open-patient]').forEach(b => b.addEventListener('click', () => { window.location.hash = 'patients/' + b.dataset.openPatient; }));
}

function statCard(label, n, tone, ico) {
  return `
    <div class="card" style="padding:14px 16px;display:flex;align-items:center;gap:12px">
      <span class="stat-ico ${tone}">${icon(ico)}</span>
      <div><div style="font:var(--t-h3);line-height:1.1">${n}</div><div class="due-meta">${label}</div></div>
    </div>`;
}

function pname(r) { return r.patient?.full_name || r.patient?.patient_code || 'Patient (restricted)'; }

function section(title, sub, list, stage) {
  if (!list.length) return '';
  return `
    <div class="card card-flush" style="margin-bottom:var(--s5)">
      <div class="card-head" style="padding:14px 18px">
        <div><h3 style="font-size:15.5px">${title}</h3><div class="due-meta">${sub}</div></div>
        <span class="badge badge-neutral">${list.length}</span>
      </div>
      <div style="padding:4px 12px 12px;display:flex;flex-direction:column;gap:8px">
        ${list.map(r => sessionRow(r, stage)).join('')}
      </div>
    </div>`;
}

function sessionRow(r, stage) {
  const k = sessionKind(r.kind);
  const when = r.scheduled_at ? new Date(r.scheduled_at) : null;
  const whenStr = when ? when.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const overdue = stage === 'scheduled' && when && when < new Date();
  const place = [r.patient?.city, r.patient?.state].filter(Boolean).join(', ');
  return `
    <div class="lever-row" style="align-items:flex-start">
      <span class="stat-ico ${r.kind === 'nutrition' ? 'ok' : r.kind === 'caregiver' ? 'info' : 'warn'}" style="width:34px;height:34px;border-radius:9px">${icon(k.icon)}</span>
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" data-open-patient="${r.patient?.id || ''}" ${r.patient?.id ? '' : 'disabled'}
            style="padding:2px 6px;font-weight:700;font-size:14px">${pname(r)}</button>
          <span class="badge badge-neutral" style="font-size:11px">${k.label}</span>
          ${overdue ? `<span class="badge badge-danger">was due</span>` : ''}
        </div>
        <div class="due-meta" style="margin-top:3px">
          ${r.patient?.patient_code || ''}${place ? ' · ' + place : ''}${r.patient?.primary_language ? ' · speaks ' + r.patient.primary_language : ''}
        </div>
        <div class="hist-meta" style="margin-top:5px">
          ${stage === 'scheduled' ? `<strong style="color:var(--ink-2)">${whenStr}</strong> · with ${r.assignee?.full_name || 'unassigned'}` : `invited by ${r.inviter?.full_name || 'N/A'} · ${formatRelativeTime(r.invited_at || r.created_at)}`}
        </div>
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        ${stage === 'agreed' ? `
          <button class="btn btn-primary btn-sm" data-act="schedule" data-id="${r.id}">${icon('calendar')}Schedule</button>` : ''}
        ${stage === 'scheduled' ? `
          <button class="btn btn-primary btn-sm" data-act="held" data-id="${r.id}">${icon('check')}Held it</button>
          <button class="btn btn-ghost btn-sm" data-act="no_show" data-id="${r.id}">No-show</button>
          <button class="btn btn-ghost btn-sm" data-act="cancelled" data-id="${r.id}">Cancel</button>` : ''}
        ${stage === 'invited' ? `
          <button class="btn btn-secondary btn-sm" data-act="agreed" data-id="${r.id}">${icon('check')}They said yes</button>
          <button class="btn btn-ghost btn-sm" data-act="declined" data-id="${r.id}">Declined</button>` : ''}
      </div>
    </div>`;
}

async function quickUpdate(id, patch, message) {
  const sb = getSupabase();
  try {
    await mustWrite(sb.from('care_sessions').update(patch).eq('id', id), 'session');
    showToast(message, 'success');
    await load();
  } catch (e) { showToast('Could not update: ' + e.message, 'error'); }
}

// Managers/admins can hand the session to any specialist; specialists take it themselves.
async function loadAssignables() {
  if (assignables) return assignables;
  const sb = getSupabase();
  try {
    const { data } = await sb.from('profiles')
      .select('id, full_name, role')
      .in('role', ['therapist', 'nutritionist', 'manager', 'admin'])
      .eq('is_active', true)
      .order('full_name');
    assignables = data || [];
  } catch { assignables = []; }
  return assignables;
}

// Continuity: who last held (or already has scheduled) a session of this
// kind with this patient. Follow-ups go back to them by default.
async function prevSpecialistFor(r) {
  if (!r?.patient?.id && !r?.patient_id) return null;
  const pid = r.patient_id || r.patient.id;
  // v89: for nutrition, whoever HOLDS the patient is the answer, full stop.
  // Falling through to "whoever ran the last session" would quietly propose a
  // different person from the one the worklist says owns them.
  if (r.kind === 'nutrition') {
    try {
      const { data } = await getSupabase().from('patients')
        .select('nutrition_owner_id, assignee:profiles!patients_nutrition_owner_id_fkey(full_name)')
        .eq('id', pid).single();
      if (data?.nutrition_owner_id) return { assigned_to: data.nutrition_owner_id, assignee: data.assignee };
    } catch { /* fall through to the session history below */ }
  }
  try {
    const { data } = await getSupabase().from('care_sessions')
      .select('assigned_to, assignee:profiles!care_sessions_assigned_to_fkey(full_name)')
      .eq('patient_id', pid).eq('kind', r.kind)
      .in('status', ['held', 'scheduled'])
      .not('assigned_to', 'is', null)
      .neq('id', r.id)
      .order('created_at', { ascending: false }).limit(1);
    return data?.[0] || null;
  } catch { return null; }
}

function openScheduleModal(id) {
  const r = rows.find(x => x.id === id);
  const me = getCurrentProfile();
  const el = document.createElement('div');
  const defaultDt = (() => { const d = new Date(Date.now() + 24 * 3600 * 1000); d.setMinutes(0, 0, 0); return d; })();
  const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      Scheduling the <strong>${sessionKind(r?.kind).label}</strong> session for <strong>${pname(r || {})}</strong>.
      Their mentor will remind them on the next call.</p>
    <div class="form-row">
      <div class="form-group"><label class="form-label">When</label>
        <input class="input" type="datetime-local" id="sm-when" value="${toLocalInput(defaultDt)}" /></div>
      <div class="form-group"><label class="form-label">Who holds it</label>
        <select class="select" id="sm-who"><option value="${me.id}">Me · ${me.full_name}</option></select>
        <div id="sm-continuity" class="due-meta" style="margin-top:5px;display:none"></div></div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="sm-cancel">Cancel</button>
      <button class="btn btn-primary" id="sm-save">${icon('calendar')}Set the date</button>
    </div>`;
  showModal({ title: 'Schedule session', content: el, size: 'lg' });

  // Fill the "who" list, then default to the continuity person if there is one.
  (async () => {
    const sel = el.querySelector('#sm-who');
    if (!sel) return;
    if (isManagerOrAdmin()) {
      const list = await loadAssignables();
      if (list.length) sel.innerHTML = list.map(a => `<option value="${a.id}" ${a.id === me.id ? 'selected' : ''}>${a.full_name}${a.id === me.id ? ' (me)' : ''}</option>`).join('');
    }
    const prev = r?.assigned_to
      ? { assigned_to: r.assigned_to, assignee: r.assignee }   // inviter already routed it
      : await prevSpecialistFor(r);
    if (!prev?.assigned_to) return;
    const name = prev.assignee?.full_name || 'the previous specialist';
    if (![...sel.options].some(o => o.value === prev.assigned_to)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${prev.assigned_to}">${name} · saw them before</option>`);
    }
    sel.value = prev.assigned_to;
    const hint = el.querySelector('#sm-continuity');
    if (hint) { hint.style.display = ''; hint.textContent = `${name} has worked with this patient before, kept with them for continuity.`; }
  })();
  el.querySelector('#sm-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#sm-save').addEventListener('click', async () => {
    const when = el.querySelector('#sm-when').value;
    if (!when) { showToast('Pick a date and time', 'warning'); return; }
    const btn = el.querySelector('#sm-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    try {
      await mustWrite(getSupabase().from('care_sessions').update({
        status: 'scheduled',
        scheduled_at: new Date(when).toISOString(),
        assigned_to: el.querySelector('#sm-who').value,
      }).eq('id', id), 'schedule');
      closeModal();
      showToast('Scheduled. The mentor will remind them on the next call', 'success');
      await load();
    } catch (e) {
      showToast('Could not schedule: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('calendar')}Set the date`;
    }
  });
}

function openHeldModal(id) {
  const r = rows.find(x => x.id === id);
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">
      How did the session with <strong>${pname(r || {})}</strong> go? A line or two. The next
      person to call them will read this.</p>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Duration (minutes)</label>
        <input class="input" type="number" id="hm-mins" min="5" max="240" placeholder="45" /></div>
      <div class="form-group"></div>
    </div>
    <div class="form-group"><label class="form-label">Session notes</label>
      <textarea class="textarea" id="hm-notes" placeholder="What you worked on, how they responded, what to build on next time…"></textarea></div>
    <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 var(--s4)">
      Tip: record a fresh PHQ-4 / QoL score on their profile after a few sessions. That's how the change becomes visible.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="hm-cancel">Cancel</button>
      <button class="btn btn-primary" id="hm-save">${icon('checkCircle')}Session held</button>
    </div>`;
  showModal({ title: 'Record the session', content: el, size: 'lg' });
  el.querySelector('#hm-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#hm-save').addEventListener('click', async () => {
    const btn = el.querySelector('#hm-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    try {
      const mins = parseInt(el.querySelector('#hm-mins').value, 10);
      await mustWrite(getSupabase().from('care_sessions').update({
        status: 'held',
        held_at: new Date().toISOString(),
        duration_mins: Number.isFinite(mins) ? mins : null,
        session_notes: el.querySelector('#hm-notes').value.trim() || null,
      }).eq('id', id), 'session');
      closeModal();
      showToast('Session recorded. It now counts in the impact analytics', 'success');
      await load();
    } catch (e) {
      showToast('Could not save: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('checkCircle')}Session held`;
    }
  });
}
