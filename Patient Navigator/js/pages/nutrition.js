// ============================================================
// Patient Navigator: Nutrition worklist
// The nutrition team's daily view, in two halves:
//   In care  - everyone a caregiver mentor has explicitly assigned to
//              nutrition (the 'nutritionist_assigned' lever), or who has
//              nutrition work on file, with quick logging.
//   Outreach - people the caregiver team already knows well (3+ real
//              conversations) who have gone quiet for 4+ days and have
//              never been offered nutrition support. Built fresh every
//              day by build_daily_assignments (sql/88). Optional work.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile, getUserRole, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { navigate } from '../router.js';
import { openAssessmentFlow } from '../components/assessmentFlow.js';
import { openCallForm } from '../components/callForm.js';
import { formatRelativeTime, capitalize, formatDate } from '../utils/formatters.js';
import { giLabel, leverLabel } from '../utils/catalog.js';
import { AVATAR_COLORS, avatarColor, initials } from '../utils/avatar.js';


let tab = 'care';   // 'care' | 'outreach'
let scope = null;   // 'mine' | 'unclaimed' | 'all': picked after first load
let query = '';     // the search box
let outScope = null;   // 'mine' | 'all': picked after first load
let outQuery = '';
let counts = {};    // tab -> how many, filled in as each list arrives

export async function renderNutrition(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Nutrition</h1>
        <p class="header-subtitle" id="nut-sub" style="margin:4px 0 0"></p>
      </div>
      <span class="badge badge-primary" id="nut-count">…</span>
    </div>
    <div class="chip-row" id="nut-tabs" style="margin:0 0 var(--s4)"></div>
    <div id="nut-panel"></div>`;
  counts = {};
  paintTabs(container);
  await openTab(container);
  // Fill the other tab's number so the team can see at a glance whether
  // there is outreach waiting, without having to click into it.
  otherCount(container);
}

// Counts land at three different moments (active list, background count,
// tab switch). Rebuilding the bar each time tore the buttons out from under
// whoever was mid-click, so build once and only re-label after that.
function paintTabs(container) {
  const el = container.querySelector('#nut-tabs');
  if (!el) return;
  const labels = {
    care: `In care${counts.care != null ? ' · ' + counts.care : ''}`,
    outreach: `Outreach${counts.outreach != null ? ' · ' + counts.outreach : ''}`,
  };
  if (!el.querySelector('[data-tab]')) {
    el.innerHTML = Object.keys(labels)
      .map(k => `<button class="fchip" data-tab="${k}"></button>`).join('');
    el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      if (tab === b.dataset.tab) return;
      tab = b.dataset.tab;
      paintTabs(container);
      openTab(container).then(() => otherCount(container));
    }));
  }
  el.querySelectorAll('[data-tab]').forEach(b => {
    b.textContent = labels[b.dataset.tab];
    b.classList.toggle('on', tab === b.dataset.tab);
  });
}

async function otherCount(container) {
  const sb = getSupabase();
  try {
    if (counts.outreach == null) {
      const { data } = await sb.rpc('get_nutrition_outreach');
      counts.outreach = (data || []).length;
    }
    if (counts.care == null) {
      const { data } = await sb.rpc('get_nutrition_worklist');
      counts.care = (data || []).length;
    }
    paintTabs(container);
  } catch { /* a missing count is not worth an error state */ }
}

async function openTab(container) {
  const sub = container.querySelector('#nut-sub');
  const panel = container.querySelector('#nut-panel');
  if (!panel) return;
  const skeleton = Array(4).fill('<div class="skeleton skeleton-row" style="height:96px;margin-bottom:10px"></div>').join('');
  if (tab === 'care') {
    if (sub) sub.innerHTML = 'Everyone with nutrition work on file. <strong>Press Claim on anyone you are going to call</strong> - they are yours from that moment, and they stay yours until you hand them back or a lead moves them. Whoever holds a patient is the one who calls them.';
    panel.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center;margin-bottom:var(--s5)">
        <div class="chip-row" id="nut-scopes" style="margin:0"></div>
        <button class="btn btn-secondary btn-sm" id="nut-claim-batch" style="display:none">${icon('handHeart')}Claim next 5</button>
        <div style="flex:1 1 220px;min-width:200px;position:relative">
          <input class="form-input" id="nut-search" type="search" autocomplete="off"
            placeholder="Search name, patient code, phone or city" value="${query.replace(/"/g, '&quot;')}" />
        </div>
      </div>
      <div id="nut-list">${skeleton}</div>`;
    await load(container);
  } else {
    if (sub) sub.innerHTML = 'People the caregiver team already knows: <strong>3 or more real conversations</strong>, and nobody has called them for <strong>4 days or more</strong>. None of them has been offered nutrition support yet. Call and offer it. This list is optional - nothing is overdue, and a fresh set is picked every morning.';
    panel.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center;margin-bottom:var(--s5)">
        <div class="chip-row" id="out-scopes" style="margin:0"></div>
        <div style="flex:1 1 220px;min-width:200px;position:relative">
          <input class="form-input" id="out-search" type="search" autocomplete="off"
            placeholder="Search name, patient code, phone or city" value="${outQuery.replace(/"/g, '&quot;')}" />
        </div>
      </div>
      <div id="out-list">${skeleton}</div>`;
    await loadOutreach(container);
  }
}

// Free-text search across everything a nutritionist would have on hand when
// they are trying to find one person: the name, the code, the number they are
// about to dial, and where they live.
function haystack(r) {
  return [r.full_name, r.patient_code, r.phone_full, r.city, r.state,
    r.continuity_name, r.assigned_by, giLabel(r.gi_subtype) || r.cancer_type]
    .filter(Boolean).join(' ').toLowerCase();
}

// The whole worklist stays in memory between repaints: claiming has to feel
// instant and must not throw away scroll position or the open chip, which is
// the difference between forty claims in twenty minutes and twelve.
let careRows = [];

async function load(container) {
  const sb = getSupabase();
  const list = container.querySelector('#nut-list');
  if (!list) return;
  try {
    const { data, error } = await sb.rpc('get_nutrition_worklist');
    if (error) throw error;
    careRows = data || [];
    counts.care = careRows.length; paintTabs(container);
    paint(container);
  } catch (e) {
    list.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't load the worklist</h4><p>${e.message}</p></div>`;
  }
}

function paint(container) {
  const list = container.querySelector('#nut-list');
  const chips = container.querySelector('#nut-scopes');
  if (!list) return;
  const rows = careRows;
  const me = getCurrentProfile();
  const mine = rows.filter(r => r.continuity_id && r.continuity_id === me?.id);
  const unclaimed = rows.filter(r => !r.continuity_id);
  if (scope === null) scope = mine.length ? 'mine' : unclaimed.length ? 'unclaimed' : 'all';
  const inScope = scope === 'mine' ? mine : scope === 'unclaimed' ? unclaimed : rows;
  const q = query.trim().toLowerCase();
  // Search runs across the whole worklist, not just the open tab. Typing a
  // name and getting "no results" because the person sits under another chip
  // is exactly the dead end this is meant to remove.
  const searched = q ? rows.filter(r => haystack(r).includes(q)) : null;
  const shown = searched || inScope;

  const search = container.querySelector('#nut-search');
  if (search && !search.dataset.wired) {
    search.dataset.wired = '1';
    search.addEventListener('input', () => { query = search.value; paint(container); });
  }

  if (chips) {
    chips.innerHTML = [
      ['mine', `My patients · ${mine.length}`],
      ['unclaimed', `Unclaimed · ${unclaimed.length}`],
      ['all', `Everyone · ${rows.length}`],
    ].map(([k, l]) => `<button class="fchip ${scope === k ? 'on' : ''}" data-scope="${k}">${l}</button>`).join('');
    chips.querySelectorAll('.fchip').forEach(ch => ch.addEventListener('click', () => {
      scope = ch.dataset.scope;
      paint(container);
    }));
  }

  // "Claim next 5" is the affordance that matches the real situation: forty
  // numbers and twenty minutes. set_nutrition_owner already takes an array.
  const batch = container.querySelector('#nut-claim-batch');
  if (batch) {
    const canClaim = getUserRole() === 'nutritionist';
    const take = unclaimed.slice(0, 5);
    batch.style.display = (canClaim && scope === 'unclaimed' && take.length > 1 && !searched) ? '' : 'none';
    batch.textContent = '';
    batch.insertAdjacentHTML('beforeend', `${icon('handHeart')}Claim next ${take.length}`);
    if (!batch.dataset.wired) {
      batch.dataset.wired = '1';
      batch.addEventListener('click', () => claimPatients(container, unclaimed.slice(0, 5), batch));
    }
  }

  const countEl = container.querySelector('#nut-count');
  if (countEl) countEl.textContent = searched
    ? `${shown.length} match${shown.length === 1 ? '' : 'es'}`
    : `${shown.length} ${scope === 'mine' ? 'in your care' : scope === 'unclaimed' ? 'waiting to be claimed' : 'in care'}`;

  if (!shown.length) {
    list.innerHTML = searched
      ? `<div class="empty"><div class="ico-wrap">${icon('search')}</div>
          <h4>No one matches “${query.trim()}”</h4>
          <p>Searching all ${rows.length} people in the nutrition worklist.</p></div>`
      : scope === 'mine'
      ? `<div class="empty"><div class="ico-wrap">${icon('leaf')}</div>
          <h4>No one is yours yet</h4>
          <p>${unclaimed.length
              ? `<strong>${unclaimed.length}</strong> people are waiting. Open <strong>Unclaimed</strong> and press <strong>Claim</strong> on anyone you are going to call.`
              : 'Everyone here is with a teammate already. A lead can move someone to you from the Team page.'}</p></div>`
      : scope === 'unclaimed'
        ? `<div class="empty"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div>
            <h4>Nobody is waiting</h4><p>Every nutrition patient has someone holding them.</p></div>`
        : `<div class="empty"><div class="ico-wrap">${icon('leaf')}</div>
            <h4>Nobody is in nutrition care yet</h4>
            <p>People arrive here when a mentor marks <strong>Nutritionist assigned</strong>, when nutrition work is logged, or when a lead assigns them to you.</p></div>`;
    return;
  }
  list.innerHTML = `<div class="nut-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">${shown.map(cardHTML).join('')}</div>`;
  wire(container, list, shown);
}

// ============================================================
// Claiming
//
// Optimistic on purpose: the RPC returns what actually happened per
// patient, so we mutate the rows we already hold and repaint instead of
// refetching 129 rows and losing the user's place. If somebody beat us to
// it, the row is corrected with the winner's name rather than silently
// reverting.
// ============================================================
async function claimPatients(container, rows, btn) {
  const sb = getSupabase();
  const me = getCurrentProfile();
  if (!rows.length || !me?.id) return;
  const label = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;border-width:2px"></span>Claiming…'; }
  try {
    const { data, error } = await sb.rpc('set_nutrition_owner', {
      p_patient_ids: rows.map(r => r.patient_id), p_to: me.id,
    });
    if (error) throw error;
    const taken = Object.fromEntries((data.taken || []).map(t => [t.patient_id, t]));
    rows.forEach(r => {
      const lost = taken[r.patient_id];
      if (lost) {
        r.continuity_id = 'someone-else';           // repainted as a colleague's
        r.continuity_name = lost.taken_by;
      } else {
        r.continuity_id = me.id;
        r.continuity_name = me.full_name;
        r.owner_source = 'self_claim';
        r.owner_since = new Date().toISOString();
        r.why_code = 'claimed';
        r.why_label = 'you claimed them';
        r.why_by = me.full_name;
        r.why_at = r.owner_since;
        r.just_claimed = true;
      }
    });
    if (data.claimed) {
      showToast(data.claimed === 1
        ? `${rows[0].full_name || 'Patient'} is yours. They are in My patients now.`
        : `${data.claimed} people are yours now.`, 'success');
    }
    (data.taken || []).forEach(t => showToast(`${t.taken_by} claimed them just now.`, 'warning'));
    paint(container);
    refreshOwnerCounts(container);
  } catch (e) {
    showToast('Could not claim: ' + e.message, 'error');
  } finally {
    if (btn && label) { btn.disabled = false; btn.innerHTML = label; }
  }
}

async function releasePatient(container, r, btn) {
  const sb = getSupabase();
  const label = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;border-width:2px"></span>'; }
  try {
    const { data, error } = await sb.rpc('set_nutrition_owner', { p_patient_ids: [r.patient_id], p_to: null });
    if (error) throw error;
    if (!data.released) throw new Error('Nothing changed. Refresh and try again.');
    r.continuity_id = null; r.continuity_name = null;
    r.owner_source = null; r.owner_since = null; r.just_claimed = false;
    r.why_code = null; r.why_label = null;
    showToast(`${r.full_name || 'They'} went back to Unclaimed. Anyone can pick them up.`, 'info');
    paint(container);
    refreshOwnerCounts(container);
  } catch (e) {
    showToast('Could not release: ' + e.message, 'error');
  } finally {
    if (btn && label) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// The dashboard tile and this page read the same numbers; keep the header
// count honest after a claim without a second round trip to the worklist.
function refreshOwnerCounts(container) {
  counts.care = careRows.length;
  paintTabs(container);
}

// Held for 60+ days with no nutrition work on file is not care, it is a
// name sitting in a list. Say so on the card, or the pool quietly moves
// into three people's names and nobody notices for a month.
const STALE_DAYS = 60;
function heldStale(r) {
  if (!r.continuity_id) return false;
  const touch = r.last_nutrition_touch ? new Date(r.last_nutrition_touch) : null;
  const since = r.owner_since ? new Date(r.owner_since) : null;
  const newest = Math.max(touch ? touch.getTime() : 0, since ? since.getTime() : 0);
  return newest > 0 && (Date.now() - newest) > STALE_DAYS * 86400000;
}

function cardHTML(r) {
  const me = getCurrentProfile();
  const isMine = !!r.continuity_id && r.continuity_id === me?.id;
  const isTheirs = !!r.continuity_id && !isMine;
  const canClaim = getUserRole() === 'nutritionist';
  const canReassign = isManagerOrAdmin();

  const name = r.full_name || r.patient_code || 'Patient';
  const loc = [r.city, r.state].filter(Boolean).join(', ') || 'N/A';
  const cancer = giLabel(r.gi_subtype) || r.cancer_type || 'Not reported';
  const levers = (r.nutrition_levers || []).filter(l => l.done);
  const leverChips = (levers.length
    ? levers.map(l => `<span class="badge badge-ok" style="font-size:11px">${leverLabel(l.lever)}${l.sessions ? ' ·' + l.sessions : ''}</span>`).join('')
    : `<span class="badge badge-warn" style="font-size:11px">No plan logged yet</span>`)
    + (heldStale(r) ? `<span class="badge badge-warn" style="font-size:11px" title="Held for two months with no nutrition work logged">Held ${STALE_DAYS}+ days, no work logged</span>` : '');
  const must = r.must_score != null
    ? `<span class="badge badge-${Number(r.must_score) >= 2 ? 'danger' : Number(r.must_score) === 1 ? 'warn' : 'ok'}">MUST ${r.must_score}</span>`
    : `<span class="faint" style="font-size:12px;color:var(--ink-3)">No MUST score yet</span>`;
  const phone = r.phone_full ? r.phone_full.replace(/\s/g, '') : '';

  // The ownership badge is the thing the eye lands on, so the control that
  // changes ownership sits right beside it rather than as a fourth unlabelled
  // glyph in the action row, where it wrapped onto a line of its own.
  const ownerBadge = isMine
    ? `<span class="badge badge-primary" style="font-size:11px" title="${r.owner_since ? 'Yours since ' + formatDate(r.owner_since) : 'Yours'}">Yours</span>
       <button class="btn btn-ghost btn-sm" data-act="release" style="padding:2px 7px;font-size:11.5px" title="Hand them back to Unclaimed">Hand back</button>`
    : isTheirs
      ? `<span class="badge badge-neutral" style="font-size:11px" title="${r.continuity_name} is holding this patient">${icon('user')}${r.continuity_name}</span>
         ${canReassign ? `<button class="btn btn-ghost btn-sm" data-act="release" style="padding:2px 7px;font-size:11.5px" title="Take this patient off ${r.continuity_name}">Unassign</button>` : ''}`
      : `<span class="badge badge-gold" style="font-size:11px" title="Nobody is holding this patient yet">Unclaimed</span>`;

  // "Why is this person on my list?", the question the team kept asking.
  // Ownership outranks everything else: a card someone just claimed must
  // not tell them a caregiver mentor ticked a lever.
  const why = r.why_label
    ? `<div style="display:flex;gap:7px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:var(--surface-2, rgba(127,127,127,.08));font-size:12px;color:var(--ink-2)">
        <span style="width:14px;height:14px;flex:none;color:var(--ink-3);margin-top:1px">${icon('info')}</span>
        <span><strong>${isTheirs ? 'On their list because' : 'On your list because'}</strong> ${r.why_label}${r.why_by && r.why_code !== 'claimed' ? ` · ${r.why_by}` : ''}${r.why_at ? ` · ${formatDate(r.why_at)}` : ''}</span>
      </div>`
    : '';

  // flex-basis, not flex:1. With four buttons on a 342px card, flex:1 shared
  // the row evenly and squeezed the primary action down to 66px; a basis
  // forces a wrap instead, so the thing you came to press stays pressable.
  const PRIMARY = 'style="flex:1 1 110px"';
  const actions = !r.continuity_id
    ? `${canClaim ? `<button class="btn btn-primary btn-sm" data-act="claim" ${PRIMARY} title="You become the one who calls them. They stay yours until you hand them back or a lead moves them.">${icon('handHeart')}Claim</button>` : ''}
       <button class="btn ${canClaim ? 'btn-secondary' : 'btn-primary'} btn-sm" data-act="log"${canClaim ? '' : ' ' + PRIMARY}>${icon('phone')}Log call</button>
       <button class="btn btn-secondary btn-sm" data-act="open" title="Open the full record">${icon('user')}Profile</button>`
    : isMine
      ? `<button class="btn btn-primary btn-sm" data-act="assess" ${PRIMARY}>${icon('activity')}Check-in</button>
         <button class="btn btn-secondary btn-sm" data-act="log">${icon('phone')}Log call</button>
         <button class="btn btn-secondary btn-sm" data-act="open">${icon('user')}Profile</button>`
      : `<button class="btn btn-secondary btn-sm" data-act="log" ${PRIMARY}>${icon('phone')}Log call</button>
         <button class="btn btn-secondary btn-sm" data-act="open">${icon('user')}Profile</button>`;

  return `
    <div class="card${r.just_claimed ? ' nut-claimed' : ''}" data-pid="${r.patient_id}" style="padding:16px;display:flex;flex-direction:column;gap:11px">
      <div style="display:flex;align-items:center;gap:11px">
        <span class="avatar" style="background:${avatarColor(name)}">${initials(name)}</span>
        <div style="flex:1;min-width:0">
          <div style="font:var(--t-body-strong);font-weight:650">${name}</div>
          <div class="faint" style="font-size:12px;color:var(--ink-3)">${r.patient_code || ''} · ${loc}</div>
        </div>
        <span style="display:flex;align-items:center;gap:5px;flex:none">${ownerBadge}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="faint" style="font-size:12.5px;color:var(--ink-2);flex:1;min-width:0">${cancer}${r.assigned_by ? ` · <span style="color:var(--ink-3)">by ${r.assigned_by}</span>` : ''}</div>
        ${must}
      </div>
      ${phone
        ? `<a class="cg-call" href="tel:${phone}" style="align-self:flex-start">${icon('phone')}<span class="tnum">${r.phone_full}</span></a>`
        : `<div class="faint" style="font-size:12.5px;color:var(--ink-3)">No number on file</div>`}
      ${why}
      <div style="display:flex;flex-wrap:wrap;gap:6px">${leverChips}</div>
      ${r.last_note ? `<div class="hist-note" style="font-size:12.5px;color:var(--ink-2);font-style:italic">“${r.last_note}”</div>` : ''}
      <div class="faint" style="font-size:11.5px;color:var(--ink-3)">${r.last_call_at ? 'Last contact ' + formatRelativeTime(r.last_call_at) : 'Not called yet'}</div>
      <div style="display:flex;gap:8px;margin-top:2px;flex-wrap:wrap">${actions}</div>
    </div>`;
}

// ============================================================
// Outreach: the pitch list
// ============================================================

function outHaystack(r) {
  return [r.full_name, r.patient_code, r.phone_full, r.city, r.state,
    r.mentor_name, giLabel(r.gi_subtype) || r.cancer_type]
    .filter(Boolean).join(' ').toLowerCase();
}

async function loadOutreach(container) {
  const sb = getSupabase();
  const list = container.querySelector('#out-list');
  if (!list) return;
  try {
    const { data, error } = await sb.rpc('get_nutrition_outreach');
    if (error) throw error;
    counts.outreach = (data || []).length; paintTabs(container);
    paintOutreach(container, data || []);
  } catch (e) {
    list.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't load the outreach list</h4><p>${e.message}</p></div>`;
  }
}

function paintOutreach(container, rows) {
  const list = container.querySelector('#out-list');
  const chips = container.querySelector('#out-scopes');
  if (!list) return;
  const mine = rows.filter(r => r.mine);
  // Managers and admins hold none of these rows themselves; opening on an
  // empty "Yours" tab would read as "there is no outreach".
  if (outScope === null) outScope = mine.length ? 'mine' : 'all';
  const q = outQuery.trim().toLowerCase();
  const searched = q ? rows.filter(r => outHaystack(r).includes(q)) : null;
  const shown = searched || (outScope === 'mine' ? mine : rows);

  const search = container.querySelector('#out-search');
  if (search && !search.dataset.wired) {
    search.dataset.wired = '1';
    search.addEventListener('input', () => { outQuery = search.value; paintOutreach(container, rows); });
  }

  if (chips) {
    chips.innerHTML = [
      ['mine', `Yours today · ${mine.length}`],
      ['all', `Whole team · ${rows.length}`],
    ].map(([k, l]) => `<button class="fchip ${outScope === k ? 'on' : ''}" data-scope="${k}">${l}</button>`).join('');
    chips.querySelectorAll('.fchip').forEach(ch => ch.addEventListener('click', () => {
      outScope = ch.dataset.scope;
      paintOutreach(container, rows);
    }));
  }
  const countEl = container.querySelector('#nut-count');
  if (countEl) countEl.textContent = searched
    ? `${shown.length} match${shown.length === 1 ? '' : 'es'}`
    : `${shown.length} to offer`;

  if (!shown.length) {
    list.innerHTML = searched
      ? `<div class="empty"><div class="ico-wrap">${icon('search')}</div>
          <h4>No one matches “${outQuery.trim()}”</h4>
          <p>Searching all ${rows.length} people on the outreach board.</p></div>`
      : outScope === 'mine'
        ? `<div class="empty"><div class="ico-wrap" style="background:var(--ok-soft);color:var(--ok)">${icon('checkCircle')}</div>
            <h4>Nothing on your list today</h4>
            <p>${rows.length ? `Your teammates are holding <strong>${rows.length}</strong>. A fresh set is picked for you each morning.` : 'A fresh set is picked each morning from people the caregiver team has spoken to at least three times.'}</p></div>`
        : `<div class="empty"><div class="ico-wrap">${icon('leaf')}</div>
            <h4>No one to reach out to right now</h4>
            <p>Everyone who fits - three or more conversations and quiet for four days - is either already in nutrition care or has been called this week. The list rebuilds every morning.</p></div>`;
    return;
  }
  list.innerHTML = `<div class="nut-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">${shown.map(outCardHTML).join('')}</div>`;
  wireOutreach(container, list, shown, () => loadOutreach(container));
}

function outCardHTML(r) {
  const name = r.full_name || r.patient_code || 'Patient';
  const loc = [r.city, r.state].filter(Boolean).join(', ') || 'N/A';
  const cancer = giLabel(r.gi_subtype) || r.cancer_type || 'Not reported';
  const phone = r.phone_full ? r.phone_full.replace(/\s/g, '') : '';
  const quiet = Number(r.days_quiet);
  return `
    <div class="card" data-pid="${r.patient_id}" data-qid="${r.queue_id}" style="padding:16px;display:flex;flex-direction:column;gap:11px">
      <div style="display:flex;align-items:center;gap:11px">
        <span class="avatar" style="background:${avatarColor(name)}">${initials(name)}</span>
        <div style="flex:1;min-width:0">
          <div style="font:var(--t-body-strong);font-weight:650">${name}</div>
          <div class="faint" style="font-size:12px;color:var(--ink-3)">${r.patient_code || ''} · ${loc}</div>
        </div>
        ${r.mine
          ? `<span class="badge badge-gold" style="font-size:11px" title="The builder picked this call for you this morning. It is not the same as holding the patient.">Picked for you</span>`
          : `<span class="badge badge-neutral" style="font-size:11px" title="Picked for ${r.assigned_name || 'a teammate'} this morning">${r.assigned_name || 'Teammate'}</span>`}
      </div>
      <div class="faint" style="font-size:12.5px;color:var(--ink-2)">${cancer}</div>
      ${phone
        ? `<a class="cg-call" href="tel:${phone}" style="align-self:flex-start">${icon('phone')}<span class="tnum">${r.phone_full}</span></a>`
        : `<div class="faint" style="font-size:12.5px;color:var(--ink-3)">No number on file</div>`}
      <div style="display:flex;gap:7px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:var(--surface-2, rgba(127,127,127,.08));font-size:12px;color:var(--ink-2)">
        <span style="width:14px;height:14px;flex:none;color:var(--ink-3);margin-top:1px">${icon('info')}</span>
        <span>The caregiver team has spoken with them <strong>${r.conversations} times</strong>${r.mentor_name ? ` (${r.mentor_name})` : ''}, and nobody has called for <strong>${quiet} days</strong>. No nutrition support offered yet.</span>
      </div>
      ${r.last_note ? `<div class="hist-note" style="font-size:12.5px;color:var(--ink-2);font-style:italic">“${r.last_note}”</div>` : ''}
      ${r.owner_name
        ? `<div class="faint" style="font-size:11.5px;color:var(--ink-3)">In nutrition care with <strong>${r.owner_name}</strong></div>`
        : ''}
      <div style="display:flex;gap:8px;margin-top:2px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm grow" data-act="log" style="flex:1">${icon('phone')}Log this call</button>
        ${(!r.owner_id && getUserRole() === 'nutritionist')
          ? `<button class="btn btn-secondary btn-sm" data-act="claim" title="Take them into your nutrition care now">${icon('handHeart')}Claim</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-act="open">${icon('user')}Profile</button>
      </div>
    </div>`;
}

function wireOutreach(container, listEl, rows, reload) {
  const byId = {}; rows.forEach(r => byId[r.patient_id] = r);
  listEl.querySelectorAll('[data-pid]').forEach(cardEl => {
    const r = byId[cardEl.dataset.pid];
    cardEl.querySelector('[data-act="open"]')?.addEventListener('click', (e) => { e.stopPropagation(); navigate('patients/' + r.patient_id); });
    // openCallForm writes the call, the support levers and any wellbeing
    // scores in one go. The DB stamps it call_team = 'nutrition', which is
    // what closes this row, rests the patient for their mentor, and - if it
    // connected - hands them to whoever made the call.
    cardEl.querySelector('[data-act="log"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openCallForm({ patient: { id: r.patient_id, full_name: r.full_name }, onSaved: reload });
    });
    // Claiming BEFORE the call, not after, is what makes the support levers
    // in that form saveable: writing them needs care rights on the patient.
    cardEl.querySelector('[data-act="claim"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const sb = getSupabase(); const me = getCurrentProfile();
      btn.disabled = true;
      try {
        const { data, error } = await sb.rpc('set_nutrition_owner', { p_patient_ids: [r.patient_id], p_to: me.id });
        if (error) throw error;
        if (data.claimed) {
          r.owner_id = me.id; r.owner_name = me.full_name;
          showToast(`${r.full_name || 'They'} are in your nutrition care now.`, 'success');
          counts.care = null; paintOutreach(container, rows); otherCount(container);
        } else if ((data.taken || []).length) {
          showToast(`${data.taken[0].taken_by} claimed them just now.`, 'warning');
          r.owner_name = data.taken[0].taken_by; r.owner_id = 'someone-else';
          paintOutreach(container, rows);
        }
      } catch (err) { showToast('Could not claim: ' + err.message, 'error'); btn.disabled = false; }
    });
  });
}

function wire(container, listEl, rows) {
  const byId = {}; rows.forEach(r => byId[r.patient_id] = r);
  const reload = () => load(container);
  listEl.querySelectorAll('[data-pid]').forEach(cardEl => {
    const r = byId[cardEl.dataset.pid];
    const on = (act, fn) => cardEl.querySelector(`[data-act="${act}"]`)?.addEventListener('click', (e) => { e.stopPropagation(); fn(e.currentTarget); });
    on('open',    () => navigate('patients/' + r.patient_id));
    on('claim',   (btn) => claimPatients(container, [r], btn));
    on('release', (btn) => releasePatient(container, r, btn));
    on('assess',  () => openAssessmentFlow({ patient: { id: r.patient_id, full_name: r.full_name }, role: 'nutritionist', onSaved: reload }));
    // Logging a call from the In-care tab has never existed, which is the
    // other half of "we marked connected and nothing happened": there was
    // nowhere on this page to mark anything.
    on('log',     () => openCallForm({ patient: { id: r.patient_id, full_name: r.full_name }, onSaved: reload }));
  });
  // The claim animation is a one-shot: clear the flag so a later repaint
  // does not replay it.
  rows.forEach(r => { if (r.just_claimed) setTimeout(() => { r.just_claimed = false; }, 700); });
}
